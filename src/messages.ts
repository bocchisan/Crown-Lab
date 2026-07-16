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

import { concat, hex, lp, u8, u16le, u64le, utf8 } from "./bytes.ts";

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
  | { kind: "done" }
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
 * action: set-channel-params
 * chain: solana-devnet
 * canister: vizcg-th777-77774-qaaea-cai
 * streamer: Gt381v8RqGQUX7vdRbC9NdZCzGuzk6ZUgcTDLfUnYdcJ
 * min_gross: 34
 * min_reputation: 0
 * enabled: true
 * counter: 7
 */
export function channelMessage(
  chain: string,
  canisterId: string,
  streamer: Uint8Array,
  minGross: bigint,
  minReputation: bigint,
  enabled: boolean,
  counter: bigint,
): Uint8Array {
  return utf8(
    `${TASKS_DOMAIN}\n` +
      `action: set-channel-params\n` +
      `chain: ${chain}\n` +
      `canister: ${canisterId}\n` +
      `streamer: ${bs58.encode(streamer)}\n` +
      `min_gross: ${minGross}\n` +
      `min_reputation: ${minReputation}\n` +
      `enabled: ${enabled}\n` +
      `counter: ${counter}\n`,
  );
}

// ---- Funding (crown:conditional-funding:v1) ------------------------------

export const FUNDING_DOMAIN = "crown:conditional-funding:v1";
/** Unversioned: a key derivation input, not a signature domain. */
export const COLLECTION_TAG = "crown:conditional-funding";

export const FUNDING_ACTION = { create: 0, released: 1, vote: 2 } as const;
export const FUNDING_CHOICE = { released: 0, notReleased: 1 } as const;

/** DOMAIN ‖ lp(chain) ‖ lp(canister_id) ‖ lp(collection_id) ‖ action ‖ lp(payload) */
export function collectionMessage(
  chain: string,
  canisterId: Uint8Array,
  collectionId: Uint8Array,
  action: number,
  payload: Uint8Array,
): Uint8Array {
  return concat(
    utf8(FUNDING_DOMAIN),
    lp(utf8(chain)),
    lp(canisterId),
    lp(collectionId),
    u8(action),
    lp(payload),
  );
}

/** goal_le ‖ duration_le — the KM handles outside the collection_id. */
export function createPayload(goal: bigint, duration: bigint): Uint8Array {
  return concat(u64le(goal), u64le(duration));
}

/**
 * collection_id = sha256(TAG ‖ len(canister_id) u8 ‖ canister_id ‖ km ‖
 * km_nonce_le). The principal is length-prefixed: principals vary in length,
 * so the encoding must stay injective.
 */
export function collectionId(canisterId: Uint8Array, km: Uint8Array, kmNonce: bigint): Uint8Array {
  return sha256(concat(utf8(COLLECTION_TAG), u8(canisterId.length), canisterId, km, u64le(kmNonce)));
}

// ---- Subscription (crown:subscription:v1) --------------------------------

export const SUBSCRIPTION_DOMAIN = "crown:subscription:v1";
const ACTION_CANCEL = 0;

/**
 * DOMAIN ‖ lp(chain) ‖ lp(canister_id) ‖ lp(escrow) ‖ 0x00 — the donor's word
 * to cancel. The donor is itself a birth field, so a forged authorization
 * addresses an escrow that does not exist.
 */
export function cancelAuthorization(
  chain: string,
  canisterId: Uint8Array,
  escrow: Uint8Array,
): Uint8Array {
  return concat(
    utf8(SUBSCRIPTION_DOMAIN),
    lp(utf8(chain)),
    lp(canisterId),
    lp(escrow),
    u8(ACTION_CANCEL),
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
