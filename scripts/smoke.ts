// Headless replay of the «Задания» scenario against the live replica and the
// live devnet, driving the very modules the page drives — salt, messages, ix,
// canisters, net. The page adds buttons on top of this and nothing else, so a
// green run here means the ported client is correct, not merely compiling.
//
// It costs real devnet money (a donate plus one task) and takes about the
// voting period plus two ingest rounds.
//
// Usage: npx tsx scripts/smoke.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { sha256 } from "@noble/hashes/sha2.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { fromHex, hex, utf8 } from "../src/bytes.ts";
import { asBytes, crownIndexActor, decodeTaskRecord, optional, tasksActor } from "../src/canisters.ts";
import { decodeTwoOutcome } from "../src/escrow.ts";
import { type ChainAddresses, createAtaIx, donateIx, ed25519VerifyIx, twoOutcomeClaimIx, twoOutcomeCreateIx } from "../src/ix.ts";
import { TASK_ACTION, TASK_CHOICE, registerPayload, taskMessage, twoOutcomeVerdictMessage } from "../src/messages.ts";
import { balancesOf, formatUsdc, send } from "../src/net.ts";
import { type Signer, burnerSigner } from "../src/signer.ts";

const DONATE = 100_000n; // the vote's weight floor is 100000
const GROSS = 30_000n;
const DURATION = 600n;
const VOTING_PERIOD = 120n;
const DEADLINE_MARGIN = 259_200n;

function config(): Record<string, string> {
  const toml = readFileSync(new URL("../config/local.toml", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of toml.split("\n")) {
    const match = /^(\w+)\s*=\s*"([^"]*)"/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

/** The e2e keypair files, driven through the very same burner signer the page uses. */
function keypairSigner(path: string, label: string): Signer {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const keypair = Keypair.fromSecretKey(secret);
  return burnerSigner({ label, secret: bs58.encode(keypair.secretKey) });
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function main(): Promise<void> {
  const cfg = config();
  const chainId = cfg.chainId ?? cfg.id ?? "solana-devnet";
  const addresses: ChainAddresses = {
    splitter: new PublicKey(cfg.splitter ?? ""),
    usdc: new PublicKey(cfg.usdc ?? ""),
    factoryTwoOutcome: new PublicKey(cfg.factory_two_outcome ?? ""),
    factoryStream: new PublicKey(cfg.factory_stream ?? ""),
  };
  const feeBps = Number(cfg.fee_bps ?? "300");
  const feeWallet = new PublicKey(cfg.fee_wallet ?? "");
  const connection = new Connection(cfg.rpc ?? "", "confirmed");
  const agent = await HttpAgent.create({ host: cfg.ic_host ?? "", shouldFetchRootKey: true });
  const tasks = tasksActor(agent, cfg.conditional_tasks ?? "");
  const index = crownIndexActor(agent, cfg.crown_index ?? "");
  const canisterId = Principal.fromText(cfg.conditional_tasks ?? "").toUint8Array();

  const donor = keypairSigner(`${homedir()}/.cache/crown-e2e/donor.json`, "донор");
  const streamer = keypairSigner(`${homedir()}/.cache/crown-e2e/streamer.json`, "стример");
  const donorKey = new PublicKey(donor.publicKey);
  const streamerKey = new PublicKey(streamer.publicKey);
  console.log(`донор ${donor.address}\nстример ${streamer.address}`);

  const resolver = optional(await tasks.get_resolver(chainId));
  if (!resolver) throw new Error("резолвер не прогрелся");
  const resolverBytes = asBytes(resolver);
  console.log(`резолвер игры: ${hex(resolverBytes)}`);

  // ---- 1. a direct donate: the reputation the vote is weighed with ----
  const before = await balancesOf(connection, streamerKey, addresses.usdc);
  const donateSig = await send(connection, donor, [
    createAtaIx(donorKey, streamerKey, addresses.usdc),
    donateIx(donorKey, streamerKey, DONATE, addresses),
  ]);
  console.log(`донат ${DONATE}: ${donateSig}`);
  const afterDonate = await balancesOf(connection, streamerKey, addresses.usdc);
  const moved = (afterDonate.usdc ?? 0n) - (before.usdc ?? 0n);
  if (moved !== DONATE) throw new Error(`сплиттер сдвинул ${moved}, а не ${DONATE} — 100% не дошло`);
  console.log(`✓ стример получил весь gross: ${formatUsdc(moved)} USDC, комиссии нет`);

  // ---- 2. the escrow ----
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + DURATION + VOTING_PERIOD + DEADLINE_MARGIN + 600n;
  const nonce = now;
  const birth = {
    donor: donor.publicKey,
    streamer: streamer.publicKey,
    gross: GROSS,
    deadline,
    resolver: resolverBytes,
    feeBps,
    feeWallet: feeWallet.toBytes(),
    nonce,
  };
  const { instruction, escrow } = twoOutcomeCreateIx(birth, addresses);
  const createSig = await send(connection, donor, [instruction]);
  console.log(`эскроу ${escrow.toBase58()}: ${createSig}`);
  console.log("✓ соль клиента совпала с солью программы — иначе init по её же PDA не прошёл бы");

  // ---- 3. register, accept, done ----
  const taskId = escrow.toBytes();
  const textHash = sha256(utf8(`crown-lab smoke ${nonce}`));
  const registerMessage = taskMessage(chainId, canisterId, taskId, TASK_ACTION.register, registerPayload(textHash, DURATION));
  const registered = await tasks.register_task({
    chain: chainId,
    donor: donor.publicKey,
    streamer: streamer.publicKey,
    gross: GROSS,
    deadline,
    resolver: resolverBytes,
    nonce,
    duration: DURATION,
    text_hash: textHash,
    signature: await donor.signMessage(registerMessage),
  });
  if ("Err" in registered) throw new Error(`register: ${registered.Err}`);
  if (hex(asBytes(registered.Ok)) !== hex(taskId)) throw new Error("task_id канистры ≠ адрес эскроу");
  console.log("✓ register: task_id канистры == адрес эскроу");

  for (const [method, action] of [
    ["accept", TASK_ACTION.accept],
    ["done", TASK_ACTION.done],
  ] as const) {
    const message = taskMessage(chainId, canisterId, taskId, action, new Uint8Array());
    const out = await tasks[method]({ chain: chainId, task_id: taskId, signature: await streamer.signMessage(message) });
    if ("Err" in out) throw new Error(`${method}: ${out.Err}`);
    console.log(`✓ ${method}`);
  }

  // ---- 4. the book must see the donate before the vote is weighed ----
  process.stdout.write("жду ингеста доната в книгу");
  let reputation = 0n;
  for (let attempt = 0; attempt < 30; attempt++) {
    reputation = await index.get_reputation(chainId, donor.publicKey, streamer.publicKey);
    if (reputation >= DONATE) break;
    process.stdout.write(".");
    await sleep(10);
  }
  console.log(`\nкнига: ${reputation} minor репутации донору`);
  if (reputation < DONATE) throw new Error("донат не доехал до книги");

  // ---- 5. vote ----
  const voteMessage = taskMessage(chainId, canisterId, taskId, TASK_ACTION.vote, new Uint8Array([TASK_CHOICE.done]));
  const voted = await tasks.vote({
    chain: chainId,
    task_id: taskId,
    voter: donor.publicKey,
    choice: { done: null },
    signature: await donor.signMessage(voteMessage),
  });
  if ("Err" in voted) throw new Error(`vote: ${voted.Err}`);
  console.log("✓ голос done принят, вес взят из книги");

  // ---- 6. the verdict ----
  console.log(`жду voting_period (${VOTING_PERIOD} с) и подпись канистры`);
  await sleep(Number(VOTING_PERIOD) + 40);
  let signature: Uint8Array | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const verdict = optional(await tasks.get_verdict(chainId, taskId));
    const found = verdict ? optional(verdict.signature) : null;
    if (verdict && found) {
      if (!("settle" in verdict.outcome)) throw new Error(`вердикт ${JSON.stringify(verdict.outcome)}, ожидался settle`);
      signature = asBytes(found);
      break;
    }
    process.stdout.write(".");
    await sleep(10);
  }
  if (!signature) throw new Error("подпись вердикта не появилась");
  console.log("\n✓ вердикт settle, подпись выдана");

  const record = decodeTaskRecord(asBytes(optional(await tasks.get_task(chainId, taskId))!.data));
  console.log(`состояние: ${Object.keys(record.state)[0]}, голосов ${record.votes.length}, вес ${record.votes[0]?.weight}`);

  // ---- 7. claim(0): the canister's signature moves real money ----
  const account = await connection.getAccountInfo(escrow);
  if (!account) throw new Error("эскроу исчез");
  const decoded = decodeTwoOutcome(new Uint8Array(account.data));
  const streamerBefore = await balancesOf(connection, streamerKey, addresses.usdc);
  const message = twoOutcomeVerdictMessage(`crown:two-outcome:${chainId}`, addresses.factoryTwoOutcome, escrow, 0);
  const claimSig = await send(connection, donor, [
    createAtaIx(donorKey, streamerKey, addresses.usdc),
    createAtaIx(donorKey, feeWallet, addresses.usdc),
    ed25519VerifyIx(decoded.resolver, signature, message),
    twoOutcomeClaimIx(escrow, decoded, 0, addresses),
  ]);
  console.log(`claim(0): ${claimSig}`);
  const streamerAfter = await balancesOf(connection, streamerKey, addresses.usdc);
  const fee = (GROSS * BigInt(feeBps)) / 10_000n;
  const payout = (streamerAfter.usdc ?? 0n) - (streamerBefore.usdc ?? 0n);
  if (payout !== GROSS - fee) throw new Error(`стример получил ${payout}, ожидалось ${GROSS - fee}`);
  console.log(`✓ стример получил ${formatUsdc(payout)} USDC (gross ${GROSS} − комиссия игры ${fee})`);

  // ---- 8. the book credits the DONOR for the game settlement ----
  const expected = reputation + GROSS - fee;
  process.stdout.write("жду ингеста расчёта игры");
  let final = 0n;
  for (let attempt = 0; attempt < 30; attempt++) {
    final = await index.get_reputation(chainId, donor.publicKey, streamer.publicKey);
    if (final >= expected) break;
    process.stdout.write(".");
    await sleep(10);
  }
  console.log(`\nкнига: ${final}, ожидалось ${expected}`);
  if (final !== expected) throw new Error("расчёт игры не атрибутирован донору");
  const anomalies = await index.get_anomaly_count();
  if (anomalies !== 0n) throw new Error(`аномалий ${anomalies}`);
  console.log(`✓ книга начислила ДОНОРУ нетто расчёта; аномалий ${anomalies}`);
  console.log("\nsmoke OK");
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
