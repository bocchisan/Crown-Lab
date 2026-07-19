// Headless replay of «Подписка» against the live replica and the live devnet,
// driving the modules the page drives. Proves the whole loop with the text
// authorization: create → release a due chunk → cancel by the donor's word,
// and the book crediting only what actually reached the owner.
//
// Usage: npx tsx scripts/smoke-subscription.ts
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { hex, utf8 } from "../src/bytes.ts";
import { asBytes } from "../src/canisters.ts";
import { decodeStream } from "../src/escrow.ts";
import { createAtaIx, ed25519VerifyIx, streamCancelIx, streamCreateIx, streamReleaseIx } from "../src/ix.ts";
import { cancelAuthorization, cancelMessage, releaseMessage } from "../src/messages.ts";
import { balancesOf, formatUsdc, send } from "../src/net.ts";
import { context, show, sleep } from "./context.ts";

const CHUNK = 10_000n;
const N_CHUNKS = 2;
const PERIOD = 45n;

async function main(): Promise<void> {
  const lab = await context();
  const donor = lab.donor;
  const owner = lab.recipient;
  const donorKey = new PublicKey(donor.publicKey);
  const ownerKey = new PublicKey(owner.publicKey);
  console.log(`донор ${donor.address}\nвладелец ${owner.address}`);

  // ---- 1. the resolver and the stream ----
  const subscriptionId = sha256(utf8(`crown-lab:smoke:${Date.now()}`));
  const resolverOut = await lab.subscription.get_resolver(lab.chainId, subscriptionId);
  if ("Err" in resolverOut) throw new Error(`get_resolver: ${resolverOut.Err}`);
  const resolver = asBytes(resolverOut.Ok);
  console.log(`резолвер подписки: ${hex(resolver).slice(0, 16)}…`);

  const t0 = BigInt(Math.floor(Date.now() / 1000));
  const birth = {
    donor: donor.publicKey,
    recipients: [owner.publicKey],
    shares: [10_000],
    chunk: CHUNK,
    nChunks: N_CHUNKS,
    t0,
    period: PERIOD,
    resolver,
    feeBps: lab.feeBps,
    feeWallet: lab.feeWallet.toBytes(),
    // Client convention: nonce = t0.
    nonce: BigInt.asUintN(64, t0),
  };
  const { instruction, escrow } = streamCreateIx(birth, lab.addresses);
  console.log(`подписка ${escrow.toBase58()}: ${await send(lab.connection, donor, [instruction])}`);
  console.log(`✓ списано вперёд ${formatUsdc(CHUNK * BigInt(N_CHUNKS))} USDC`);

  const birthArg = {
    chain: lab.chainId,
    subscription_id: subscriptionId,
    donor: donor.publicKey,
    recipients: [owner.publicKey],
    shares: [10_000],
    chunk: CHUNK,
    n_chunks: N_CHUNKS,
    t0,
    period: PERIOD,
    nonce: BigInt.asUintN(64, t0),
  };

  // ---- 2. the schedule refuses a chunk that is not due ----
  const early = await lab.subscription.request_release({ ...birthArg, index: 1 });
  if (!("Err" in early)) throw new Error("канистра выдала подпись на несозревший кусок");
  console.log(`✓ негатив: кусок 1 ещё не созрел — «${early.Err}»`);

  // ---- 3. release chunk 0 ----
  const signed = await lab.subscription.request_release({ ...birthArg, index: 0 });
  if ("Err" in signed) throw new Error(`request_release: ${signed.Err}`);
  if (new PublicKey(asBytes(signed.Ok.escrow)).toBase58() !== escrow.toBase58()) {
    throw new Error("канистра вывела другой эскроу");
  }
  const state = await readEscrow(lab, escrow);
  const ownerBefore = await balancesOf(lab.connection, ownerKey, lab.addresses.usdc);
  const bookBefore = await lab.index.get_reputation(lab.chainId, donor.publicKey, owner.publicKey);
  const release = releaseMessage(lab.domains.stream, lab.addresses.factoryStream, escrow, 0);
  const releaseTx = await send(lab.connection, donor, [
    createAtaIx(donorKey, ownerKey, lab.addresses.usdc),
    createAtaIx(donorKey, lab.feeWallet, lab.addresses.usdc),
    ed25519VerifyIx(state.resolver, asBytes(signed.Ok.signature), release),
    streamReleaseIx(escrow, state, 0, lab.addresses),
  ]);
  console.log(`выпуск куска 0: ${releaseTx}`);
  const fee = (CHUNK * BigInt(lab.feeBps)) / 10_000n;
  const ownerAfter = await balancesOf(lab.connection, ownerKey, lab.addresses.usdc);
  const payout = (ownerAfter.usdc ?? 0n) - (ownerBefore.usdc ?? 0n);
  if (payout !== CHUNK - fee) throw new Error(`владелец получил ${payout}, ожидалось ${CHUNK - fee}`);
  console.log(`✓ владелец получил ${formatUsdc(payout)} USDC (кусок ${CHUNK} − комиссия ${fee})`);

  // ---- 4. cancel by the donor's word ----
  const authorization = cancelAuthorization(lab.chainId, lab.ids.subscription, escrow.toBytes());
  console.log(show(authorization));
  const cancelSigned = await lab.subscription.request_cancel({
    ...birthArg,
    signature: await donor.signMessage(authorization),
  });
  if ("Err" in cancelSigned) throw new Error(`request_cancel: ${cancelSigned.Err}`);
  const afterRelease = await readEscrow(lab, escrow);
  const donorBefore = await balancesOf(lab.connection, donorKey, lab.addresses.usdc);
  const cancel = cancelMessage(lab.domains.stream, lab.addresses.factoryStream, escrow);
  const cancelTx = await send(lab.connection, donor, [
    ed25519VerifyIx(afterRelease.resolver, asBytes(cancelSigned.Ok.signature), cancel),
    streamCancelIx(escrow, afterRelease, lab.addresses),
  ]);
  console.log(`отмена: ${cancelTx}`);
  const donorAfter = await balancesOf(lab.connection, donorKey, lab.addresses.usdc);
  const returned = (donorAfter.usdc ?? 0n) - (donorBefore.usdc ?? 0n);
  if (returned !== CHUNK) throw new Error(`донору вернулось ${returned}, ожидался один кусок ${CHUNK}`);
  console.log(`✓ донору вернулся невыпущенный остаток ${formatUsdc(returned)} USDC`);
  const terminal = await readEscrow(lab, escrow);
  if (!terminal.settled || terminal.released !== 1) {
    throw new Error(`эскроу не терминален: settled=${terminal.settled}, released=${terminal.released}`);
  }
  console.log("✓ эскроу терминален: settled, выпущен 1 кусок из 2");

  // ---- 5. the book sees the released chunk and nothing else ----
  const expected = bookBefore + CHUNK - fee;
  process.stdout.write("жду ингеста выпуска");
  let final = 0n;
  for (let attempt = 0; attempt < 30; attempt++) {
    final = await lab.index.get_reputation(lab.chainId, donor.publicKey, owner.publicKey);
    if (final >= expected) break;
    process.stdout.write(".");
    await sleep(10);
  }
  console.log(`\nкнига: ${final}, ожидалось ${expected} (только выпущенный кусок; отмена мимо книги)`);
  if (final !== expected) throw new Error("книга не сошлась");
  const anomalies = await lab.index.get_anomaly_count();
  if (anomalies !== 0n) throw new Error(`аномалий ${anomalies}`);
  console.log(`✓ аномалий ${anomalies}`);
  console.log("\nsmoke «Подписка» OK");
}

async function readEscrow(lab: Awaited<ReturnType<typeof context>>, escrow: PublicKey) {
  const account = await lab.connection.getAccountInfo(escrow);
  if (!account) throw new Error("эскроу не найден");
  return decodeStream(new Uint8Array(account.data));
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
