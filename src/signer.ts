// Participants. Every scenario needs several of them — a donor, a streamer or
// KM, a voter, a second contributor — and each one both signs raw messages
// (the canisters authorize by wallet signature) and signs transactions.
//
// Two implementations behind one interface:
//   wallet — a real browser extension over Wallet Standard;
//   burner — a keypair the page generated or imported, kept in localStorage.
//
// Burners are a testing convenience, nothing more: they hold devnet play money
// and let one operator drive a four-party scenario without switching accounts
// twelve times. They are never a model of how a real client should behave.

import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";

export interface Signer {
  kind: "wallet" | "burner";
  /** Display name in the UI and in the log. */
  label: string;
  address: string;
  publicKey: Uint8Array;
  /** Raw Ed25519 over the exact bytes — what every canister verifies. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signed wire bytes, order preserved. */
  signTransactions(transactions: Transaction[]): Promise<Uint8Array[]>;
}

export interface StoredBurner {
  label: string;
  /** base58 of the 64-byte Solana secret key. */
  secret: string;
}

const STORAGE_KEY = "crown-lab:burners";

export function loadBurners(): StoredBurner[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as StoredBurner[];
  } catch {
    return [];
  }
}

export function saveBurners(burners: StoredBurner[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(burners));
}

export function newBurner(label: string): StoredBurner {
  return { label, secret: bs58.encode(Keypair.generate().secretKey) };
}

/**
 * Accepts both shapes a Solana key is normally written in: the CLI's JSON
 * array of 64 bytes (`~/.config/solana/id.json`) and base58 — of the secret
 * key or of a 32-byte seed.
 */
export function importBurner(label: string, text: string): StoredBurner {
  const trimmed = text.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : bs58.decode(trimmed);
  const keypair =
    bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes.slice(0, 32));
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`key must be 32 or 64 bytes, got ${bytes.length}`);
  }
  return { label, secret: bs58.encode(keypair.secretKey) };
}

export function burnerKeypair(burner: StoredBurner): Keypair {
  return Keypair.fromSecretKey(bs58.decode(burner.secret));
}

export function burnerSigner(burner: StoredBurner): Signer {
  const keypair = burnerKeypair(burner);
  return {
    kind: "burner",
    label: burner.label,
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    // The wallets sign the raw message; noble takes the 32-byte seed, which
    // is the first half of Solana's 64-byte secret key.
    signMessage: async (message) => ed25519.sign(message, keypair.secretKey.slice(0, 32)),
    signTransactions: async (transactions) =>
      transactions.map((transaction) => {
        transaction.sign(keypair);
        return new Uint8Array(transaction.serialize());
      }),
  };
}
