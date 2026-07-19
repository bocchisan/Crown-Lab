// Every byte a participant or a program signs over. Mirrors of the frozen
// layouts in the canisters' auth.rs and the shapes' assert_resolver_signed;
// test/messages.test.ts pins them against the canisters' own unit vectors.
//
// Two families live here:
//   participant messages — signed by a wallet, verified by a canister;
//   verdict messages     — signed by a canister's threshold key, verified by
//                          the on-chain program via the ed25519 instruction.

import { sha256 } from "@noble/hashes/sha2.js";
import type { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { concat, hex, u8, u16le, u64le, utf8 } from "./bytes.ts";

// ---- Tasks (crown:conditional-tasks:v1) ---------------------------------
//
// The participant messages of this game are UTF-8 text, mirroring the
// canister's auth.rs line for line. They are text because wallets refuse to
// sign anything else: Phantom runs isValidUTF8 over the payload and rejects
// the rest with "You cannot sign solana transactions using sign message".
// test/messages.test.ts pins these strings against the canister's own unit
// vectors and runs them through Phantom's actual guard.

export const TASKS_DOMAIN = "crown:conditional-tasks:v1";

/** The words the message uses, frozen with the protocol. */
export const TASK_CHOICE = { done: "done", notDone: "not_done" } as const;
export type TaskChoiceWord = (typeof TASK_CHOICE)[keyof typeof TASK_CHOICE];

export type TaskAction =
  | { kind: "register"; textHash: Uint8Array; duration: bigint }
  | { kind: "accept" }
  | { kind: "decline" }
  | { kind: "ready" }
  | { kind: "operator-refund" }
  | { kind: "vote"; choice: TaskChoiceWord };

/**
 * crown:conditional-tasks:v1
 * action: accept
 * chain: solana-devnet
 * canister: vizcg-th777-77774-qaaea-cai
 * task: 3tjoUqMwgUcyfWqYvDMGRY5gBXPNPKyY3gErYhJGqxcu
 *
 * `register` adds `text:` (hex) and `duration:`; `vote` adds `choice:`.
 * The canister derives the same text and verifies the signature over it.
 */
export function taskMessage(
  chain: string,
  canisterId: string,
  taskId: Uint8Array,
  action: TaskAction,
): Uint8Array {
  let out = `${TASKS_DOMAIN}\n`;
  out += `action: ${action.kind}\n`;
  out += `chain: ${chain}\n`;
  out += `canister: ${canisterId}\n`;
  // task_id ≡ the escrow address: base58 is the form the signer can compare
  // against an explorer.
  out += `task: ${bs58.encode(taskId)}\n`;
  if (action.kind === "register") {
    out += `text: ${hex(action.textHash)}\n`;
    out += `duration: ${action.duration}\n`;
  } else if (action.kind === "vote") {
    out += `choice: ${action.choice}\n`;
  }
  return utf8(out);
}

/**
 * crown:conditional-tasks:v1
 * action: set-profile
 * chain: solana-devnet
 * canister: vizcg-th777-77774-qaaea-cai
 * recipient: Gt381v8RqGQUX7vdRbC9NdZCzGuzk6ZUgcTDLfUnYdcJ
 * min_gross: 34
 * min_reputation: 0
 * enabled: true
 * counter: 7
 */
export function profileMessage(
  chain: string,
  canisterId: string,
  recipient: Uint8Array,
  minGross: bigint,
  minReputation: bigint,
  enabled: boolean,
  counter: bigint,
): Uint8Array {
  return utf8(
    `${TASKS_DOMAIN}\n` +
      `action: set-profile\n` +
      `chain: ${chain}\n` +
      `canister: ${canisterId}\n` +
      `recipient: ${bs58.encode(recipient)}\n` +
      `min_gross: ${minGross}\n` +
      `min_reputation: ${minReputation}\n` +
      `enabled: ${enabled}\n` +
      `counter: ${counter}\n`,
  );
}

// ---- Funding (crown:conditional-funding:v1) ------------------------------
//
// Text, mirroring the canister's auth.rs line for line, for the same reason as
// Tasks: Phantom signs valid UTF-8 and nothing else.

export const FUNDING_DOMAIN = "crown:conditional-funding:v1";
/** Unversioned: a key derivation input, not a signature domain. */
export const COLLECTION_TAG = "crown:conditional-funding";

/** The words the message uses, frozen with the protocol. */
export const FUNDING_CHOICE = { done: "done", notDone: "not_done" } as const;
export type FundingChoiceWord = (typeof FUNDING_CHOICE)[keyof typeof FUNDING_CHOICE];

export type FundingAction =
  | { kind: "create"; goal: bigint; duration: bigint }
  | { kind: "ready" }
  | { kind: "cancel" }
  | { kind: "operator-refund" }
  | { kind: "vote"; choice: FundingChoiceWord };

/**
 * crown:conditional-funding:v1
 * action: vote
 * chain: solana-devnet
 * canister: vpyes-67777-77774-qaaeq-cai
 * collection: 8290545b…
 * choice: done
 *
 * `create` adds `goal:` and `duration:`; `ready`, `cancel` and
 * `operator-refund` add nothing.
 */
export function collectionMessage(
  chain: string,
  canisterId: string,
  collectionId: Uint8Array,
  action: FundingAction,
): Uint8Array {
  let out = `${FUNDING_DOMAIN}\n`;
  out += `action: ${action.kind}\n`;
  out += `chain: ${chain}\n`;
  out += `canister: ${canisterId}\n`;
  // The collection id is an opaque hash, not an address: hex is its form.
  out += `collection: ${hex(collectionId)}\n`;
  if (action.kind === "create") {
    out += `goal: ${action.goal}\n`;
    out += `duration: ${action.duration}\n`;
  } else if (action.kind === "vote") {
    out += `choice: ${action.choice}\n`;
  }
  return utf8(out);
}

/**
 * collection_id = sha256(TAG ‖ len(canister_id) u8 ‖ canister_id ‖ recipient ‖
 * recipient_nonce_le) — still binary, and deliberately: it is the derivation
 * path of the collection's resolver, not a message anyone signs. The principal
 * is length-prefixed so principals of different lengths cannot collide.
 */
export function collectionId(
  canisterId: Uint8Array,
  recipient: Uint8Array,
  recipientNonce: bigint,
): Uint8Array {
  return sha256(
    concat(utf8(COLLECTION_TAG), u8(canisterId.length), canisterId, recipient, u64le(recipientNonce)),
  );
}

// ---- Auction (crown:auction:v1) ------------------------------------------
//
// The same text discipline as Tasks and Funding. The auction and lot ids are
// hex in the message (opaque hashes), escrows are base58 (addresses).

export const AUCTION_DOMAIN = "crown:auction:v1";
/** Unversioned: a key derivation input, not a signature domain. */
export const AUCTION_TAG = "crown:auction";

/** The words the message uses, frozen with the protocol. */
export const AUCTION_CHOICE = { done: "done", notDone: "not_done" } as const;
export type AuctionChoiceWord = (typeof AUCTION_CHOICE)[keyof typeof AUCTION_CHOICE];

export type AuctionAction =
  | {
      kind: "create";
      recipientNonce: bigint;
      duration: bigint;
      performWindow: bigint;
      minEntry: bigint;
    }
  | { kind: "accept"; lot: Uint8Array }
  | { kind: "return-lot"; lot: Uint8Array }
  | { kind: "return-entry"; escrow: Uint8Array }
  | { kind: "cancel" }
  | { kind: "ready" }
  | { kind: "operator-refund-lot"; lot: Uint8Array }
  | { kind: "operator-refund-entry"; escrow: Uint8Array }
  | { kind: "operator-cancel" }
  | { kind: "vote"; choice: AuctionChoiceWord };

/**
 * crown:auction:v1
 * action: accept
 * chain: solana-devnet
 * canister: v27v7-7x777-77774-qaaha-cai
 * auction: 166b43c4…
 * lot: e2d80f78…
 *
 * The first five lines open every action except `create`, which has no
 * `auction:` line and adds `recipient_nonce:`, `duration:`,
 * `perform_window:` and `min_entry:` instead. `accept`, `return-lot` and
 * `operator-refund-lot` add `lot:` (hex); `return-entry` and
 * `operator-refund-entry` add `escrow:` (base58); `vote` adds `choice:`.
 */
export function auctionMessage(
  chain: string,
  canisterId: string,
  auctionId: Uint8Array,
  action: AuctionAction,
): Uint8Array {
  let out = `${AUCTION_DOMAIN}\n`;
  out += `action: ${action.kind}\n`;
  out += `chain: ${chain}\n`;
  out += `canister: ${canisterId}\n`;
  if (action.kind !== "create") {
    // The auction id is an opaque hash, not an address: hex is its form.
    out += `auction: ${hex(auctionId)}\n`;
  }
  if (action.kind === "create") {
    out += `recipient_nonce: ${action.recipientNonce}\n`;
    out += `duration: ${action.duration}\n`;
    out += `perform_window: ${action.performWindow}\n`;
    out += `min_entry: ${action.minEntry}\n`;
  } else if (action.kind === "accept" || action.kind === "return-lot" || action.kind === "operator-refund-lot") {
    out += `lot: ${hex(action.lot)}\n`;
  } else if (action.kind === "return-entry" || action.kind === "operator-refund-entry") {
    out += `escrow: ${bs58.encode(action.escrow)}\n`;
  } else if (action.kind === "vote") {
    out += `choice: ${action.choice}\n`;
  }
  return utf8(out);
}

/**
 * auction_id = sha256(TAG ‖ len(canister_id) u8 ‖ canister_id ‖ recipient ‖
 * recipient_nonce_le) — the derivation path prefix of every lot resolver,
 * a calque of the Funding collection id.
 */
export function auctionId(
  canisterId: Uint8Array,
  recipient: Uint8Array,
  recipientNonce: bigint,
): Uint8Array {
  return sha256(
    concat(utf8(AUCTION_TAG), u8(canisterId.length), canisterId, recipient, u64le(recipientNonce)),
  );
}

/**
 * lot_id = sha256(auction_id ‖ text_hash): both halves are fixed 32-byte
 * hashes, so the concatenation is injective without prefixes. The lot's
 * resolver is the threshold key at path [lot_id] — money, text and auction
 * are bound by derivation.
 */
export function lotId(auctionIdBytes: Uint8Array, textHash: Uint8Array): Uint8Array {
  return sha256(concat(auctionIdBytes, textHash));
}

// ---- Subscription (crown:subscription:v1) --------------------------------

export const SUBSCRIPTION_DOMAIN = "crown:subscription:v1";
const ACTION_CANCEL = "cancel";

/**
 * crown:subscription:v1
 * action: cancel
 * chain: solana-devnet
 * canister: vg3po-ix777-77774-qaafa-cai
 * escrow: CS1mmfBkPLimY6WLGczafmQBiQNUKTUmQrCfDBKUJEyz
 *
 * The donor's word to cancel. The donor is itself a birth field, so a forged
 * authorization addresses an escrow that does not exist.
 */
export function cancelAuthorization(
  chain: string,
  canisterId: string,
  escrow: Uint8Array,
): Uint8Array {
  return utf8(
    `${SUBSCRIPTION_DOMAIN}\n` +
      `action: ${ACTION_CANCEL}\n` +
      `chain: ${chain}\n` +
      `canister: ${canisterId}\n` +
      `escrow: ${bs58.encode(escrow)}\n`,
  );
}

// ---- verdict messages (verified on-chain) --------------------------------

export const RELEASE_TAG = 0x00;
export const CANCEL_TAG = 0x01;

/** two-outcome claim: DOMAIN ‖ program ‖ escrow ‖ outcome (settle=0, cancel/refund=1). */
export function twoOutcomeVerdictMessage(
  domain: string,
  factory: PublicKey,
  escrow: PublicKey,
  outcome: number,
): Uint8Array {
  return concat(utf8(domain), factory.toBytes(), escrow.toBytes(), u8(outcome));
}

/** stream release: DOMAIN ‖ program ‖ escrow ‖ 0x00 ‖ index_le. */
export function releaseMessage(
  domain: string,
  factory: PublicKey,
  escrow: PublicKey,
  index: number,
): Uint8Array {
  return concat(utf8(domain), factory.toBytes(), escrow.toBytes(), u8(RELEASE_TAG), u16le(index));
}

/** stream cancel: DOMAIN ‖ program ‖ escrow ‖ 0x01. */
export function cancelMessage(domain: string, factory: PublicKey, escrow: PublicKey): Uint8Array {
  return concat(utf8(domain), factory.toBytes(), escrow.toBytes(), u8(CANCEL_TAG));
}
