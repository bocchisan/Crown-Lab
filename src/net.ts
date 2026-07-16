// Talking to devnet: sending one transaction, reading balances, funding a
// burner. Two lessons from the mini app are baked in here rather than left to
// each call site:
//
//   1. The blockhash is fetched last, after every slow canister call, because
//      wallets judge a transaction's cluster by its blockhash and a stale one
//      reads to them as "this is for mainnet".
//   2. The public devnet RPC throttles bursts, so reads and sends retry with
//      a backoff instead of failing the scenario.

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { ata } from "./ix.ts";
import type { Signer } from "./signer.ts";

/** USDC minor units: 6 decimals, as the mint says. */
export const USDC_DECIMALS = 6;

export async function withRetry<T>(what: string, call: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw new Error(`${what}: ${describe(last)}`);
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Builds, signs and sends one transaction, then waits for confirmation.
 * The blockhash is taken here, immediately before signing — never earlier.
 */
export async function send(
  connection: Connection,
  signer: Signer,
  instructions: TransactionInstruction[],
): Promise<string> {
  const latest = await withRetry("getLatestBlockhash", () => connection.getLatestBlockhash());
  const transaction = new Transaction({
    feePayer: new PublicKey(signer.publicKey),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  transaction.add(...instructions);
  const [wire] = await signer.signTransactions([transaction]);
  if (!wire) throw new Error("подписант не вернул транзакцию");
  const signature = await withRetry("sendRawTransaction", () =>
    connection.sendRawTransaction(wire, { skipPreflight: false }),
  );
  const result = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err) throw new Error(`транзакция отклонена: ${JSON.stringify(result.value.err)}`);
  return signature;
}

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export interface Balances {
  /** Lamports. */
  sol: bigint;
  /** USDC minor units; null when the wallet has no USDC account yet. */
  usdc: bigint | null;
}

export async function balancesOf(
  connection: Connection,
  owner: PublicKey,
  usdcMint: PublicKey,
): Promise<Balances> {
  const sol = BigInt(await withRetry("getBalance", () => connection.getBalance(owner)));
  const account = await withRetry("getTokenAccount", () =>
    connection.getAccountInfo(ata(owner, usdcMint)),
  );
  if (!account) return { sol, usdc: null };
  // SPL token account: amount is a u64 at offset 64.
  const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  return { sol, usdc: view.getBigUint64(64, true) };
}

/**
 * Funds a participant from another one: SOL for rent and fees, USDC to spend.
 * Creating the recipient's USDC account is idempotent, so this is safe to
 * press twice.
 */
export async function fund(
  connection: Connection,
  from: Signer,
  to: PublicKey,
  usdcMint: PublicKey,
  lamports: bigint,
  usdcAmount: bigint,
): Promise<string> {
  const payer = new PublicKey(from.publicKey);
  const instructions: TransactionInstruction[] = [];
  if (lamports > 0n) {
    instructions.push(
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: Number(lamports) }),
    );
  }
  if (usdcAmount > 0n) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata(to, usdcMint), to, usdcMint));
    instructions.push(
      createTransferCheckedInstruction(
        ata(payer, usdcMint),
        usdcMint,
        ata(to, usdcMint),
        payer,
        usdcAmount,
        USDC_DECIMALS,
      ),
    );
  }
  if (instructions.length === 0) throw new Error("нечего переводить");
  return send(connection, from, instructions);
}

/** 1_234_500 -> "1.2345" — minor units are what every layout speaks. */
export function formatUsdc(amount: bigint | null): string {
  if (amount === null) return "—";
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(4);
}
