// Headless replay of «Сбор» against the live replica and the live devnet,
// driving the modules the page drives. Proves the whole loop with the text
// message format: create → contribute → released → vote → verdict → claim,
// and the book crediting the CONTRIBUTOR, not the KM.
//
// Usage: npx tsx scripts/smoke-funding.ts
import { Principal } from "@dfinity/principal";
import { PublicKey } from "@solana/web3.js";

import { hex } from "../src/bytes.ts";
import { asBytes, decodeCollectionRecord, optional } from "../src/canisters.ts";
import { decodeTwoOutcome } from "../src/escrow.ts";
import { createAtaIx, ed25519VerifyIx, twoOutcomeClaimIx, twoOutcomeCreateIx } from "../src/ix.ts";
import { FUNDING_CHOICE, collectionId, collectionMessage, twoOutcomeVerdictMessage } from "../src/messages.ts";
import { balancesOf, formatUsdc, send } from "../src/net.ts";
import { context, show, sleep } from "./context.ts";

const CONTRIBUTION = 30_000n;
const GOAL = 1_000_000n;
const DURATION = 300n;
const VOTING_PERIOD = 120n;
const DEADLINE_MARGIN = 259_200n;

async function main(): Promise<void> {
  const lab = await context();
  // The KM is the streamer key: the donor's reputation is local to it, and a
  // vote is weighed by book[(chain, voter, km)] — the quorum is 150000.
  const km = lab.streamer;
  const donor = lab.donor;
  const kmKey = new PublicKey(km.publicKey);
  const donorKey = new PublicKey(donor.publicKey);
  console.log(`КМ ${km.address}\nвкладчик ${donor.address}`);

  const weight = await lab.index.get_reputation(lab.chainId, donor.publicKey, km.publicKey);
  console.log(`вес голоса вкладчика: ${weight} (кворум 150000)`);
  if (weight < 150_000n) throw new Error("веса не хватит на кворум — сначала донат");

  // ---- 1. the collection ----
  const kmNonce = BigInt(Math.floor(Date.now() / 1000));
  // The id hashes the raw principal bytes; the message names it in text.
  const id = collectionId(Principal.fromText(lab.ids.funding).toUint8Array(), km.publicKey, kmNonce);
  const createMessage = collectionMessage(lab.chainId, lab.ids.funding, id, {
    kind: "create",
    goal: GOAL,
    duration: DURATION,
  });
  console.log(show(createMessage));
  const created = await lab.funding.create_collection({
    chain: lab.chainId,
    km: km.publicKey,
    km_nonce: kmNonce,
    goal: GOAL,
    duration: DURATION,
    signature: await km.signMessage(createMessage),
  });
  if ("Err" in created) throw new Error(`create_collection: ${created.Err}`);
  if (hex(asBytes(created.Ok)) !== hex(id)) throw new Error("collection_id канистры ≠ локальный");
  console.log("✓ коллекция создана; collection_id канистры совпал с локальным");

  const resolver = optional(await lab.funding.get_resolver(lab.chainId, id));
  if (!resolver) throw new Error("резолвер коллекции не готов");
  const resolverBytes = asBytes(resolver);
  console.log(`резолвер коллекции: ${hex(resolverBytes).slice(0, 16)}… (свой у каждой коллекции)`);

  // ---- 2. the contribution ----
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + DURATION + VOTING_PERIOD + DEADLINE_MARGIN + 600n;
  const nonce = now;
  const { instruction, escrow } = twoOutcomeCreateIx(
    {
      donor: donor.publicKey,
      streamer: km.publicKey,
      gross: CONTRIBUTION,
      deadline,
      resolver: resolverBytes,
      feeBps: lab.feeBps,
      feeWallet: lab.feeWallet.toBytes(),
      nonce,
    },
    lab.addresses,
  );
  console.log(`вклад ${escrow.toBase58()}: ${await send(lab.connection, donor, [instruction])}`);

  // ---- 3. released, then the vote ----
  const releasedMessage = collectionMessage(lab.chainId, lab.ids.funding, id, { kind: "released" });
  const released = await lab.funding.released({
    chain: lab.chainId,
    collection_id: id,
    signature: await km.signMessage(releasedMessage),
  });
  if ("Err" in released) throw new Error(`released: ${released.Err}`);
  console.log("✓ released: коллекция ушла в голосование");

  const voteMessage = collectionMessage(lab.chainId, lab.ids.funding, id, {
    kind: "vote",
    choice: FUNDING_CHOICE.released,
  });
  console.log(show(voteMessage));
  const voted = await lab.funding.vote({
    chain: lab.chainId,
    collection_id: id,
    voter: donor.publicKey,
    choice: { released: null },
    signature: await donor.signMessage(voteMessage),
  });
  if ("Err" in voted) throw new Error(`vote: ${voted.Err}`);
  console.log("✓ голос released принят, вес взят из книги");

  // ---- 4. the verdict ----
  // The window closing is not the verdict: the canister's timer (30 s) moves
  // the collection to decided, so the signature has to be waited for, not
  // asked once.
  console.log(`жду voting_period (${VOTING_PERIOD} с) и тик канистры`);
  await sleep(Number(VOTING_PERIOD) + 10);
  const request = () =>
    lab.funding.request_signature({
      chain: lab.chainId,
      collection_id: id,
      donor: donor.publicKey,
      gross: CONTRIBUTION,
      deadline,
      nonce,
    });
  let signed = await request();
  for (let attempt = 0; "Err" in signed && attempt < 12; attempt++) {
    if (!signed.Err.includes("not decided")) break;
    process.stdout.write(".");
    await sleep(10);
    signed = await request();
  }
  if ("Err" in signed) throw new Error(`request_signature: ${signed.Err}`);
  const verdict = Object.keys(signed.Ok.outcome)[0];
  if (!("settle" in signed.Ok.outcome)) throw new Error(`вердикт ${verdict}, ожидался settle`);
  if (new PublicKey(asBytes(signed.Ok.escrow)).toBase58() !== escrow.toBase58()) {
    throw new Error("канистра вывела другой эскроу");
  }
  console.log("✓ вердикт settle, подпись выдана для нашего вклада");

  const record = decodeCollectionRecord(asBytes(optional(await lab.funding.get_collection(lab.chainId, id))!.data));
  console.log(`состояние: ${Object.keys(record.state)[0]}, голосов ${record.votes.length}, вес ${record.votes[0]?.weight}`);

  // ---- 5. claim(0): the money moves ----
  const account = await lab.connection.getAccountInfo(escrow);
  if (!account) throw new Error("эскроу исчез");
  const decoded = decodeTwoOutcome(new Uint8Array(account.data));
  const kmBefore = await balancesOf(lab.connection, kmKey, lab.addresses.usdc);
  const bookBefore = await lab.index.get_reputation(lab.chainId, donor.publicKey, km.publicKey);
  const message = twoOutcomeVerdictMessage(lab.domains.twoOutcome, lab.addresses.factoryTwoOutcome, escrow, 0);
  const tx = await send(lab.connection, donor, [
    createAtaIx(donorKey, kmKey, lab.addresses.usdc),
    createAtaIx(donorKey, lab.feeWallet, lab.addresses.usdc),
    ed25519VerifyIx(decoded.resolver, asBytes(signed.Ok.signature), message),
    twoOutcomeClaimIx(escrow, decoded, 0, lab.addresses),
  ]);
  console.log(`claim(0): ${tx}`);
  const fee = (CONTRIBUTION * BigInt(lab.feeBps)) / 10_000n;
  const kmAfter = await balancesOf(lab.connection, kmKey, lab.addresses.usdc);
  const payout = (kmAfter.usdc ?? 0n) - (kmBefore.usdc ?? 0n);
  if (payout !== CONTRIBUTION - fee) throw new Error(`КМ получил ${payout}, ожидалось ${CONTRIBUTION - fee}`);
  console.log(`✓ КМ получил ${formatUsdc(payout)} USDC (вклад ${CONTRIBUTION} − комиссия ${fee})`);

  // ---- 6. the book credits the CONTRIBUTOR ----
  const expected = bookBefore + CONTRIBUTION - fee;
  process.stdout.write("жду ингеста расчёта");
  let final = 0n;
  for (let attempt = 0; attempt < 30; attempt++) {
    final = await lab.index.get_reputation(lab.chainId, donor.publicKey, km.publicKey);
    if (final >= expected) break;
    process.stdout.write(".");
    await sleep(10);
  }
  console.log(`\nкнига: ${final}, ожидалось ${expected}`);
  if (final !== expected) throw new Error("расчёт не атрибутирован вкладчику");
  const anomalies = await lab.index.get_anomaly_count();
  if (anomalies !== 0n) throw new Error(`аномалий ${anomalies}`);
  console.log(`✓ книга начислила ВКЛАДЧИКУ нетто расчёта; аномалий ${anomalies}`);
  console.log("\nsmoke «Сбор» OK");
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
