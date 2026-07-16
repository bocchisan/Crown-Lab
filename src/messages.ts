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

import { concat, lp, u8, u16le, u64le, u128le, utf8 } from "./bytes.ts";

// ---- Tasks (crown:conditional-tasks:v1) ---------------------------------

export const TASKS_DOMAIN = "crown:conditional-tasks:v1";

export const TASK_ACTION = {
  register: 0,
  accept: 1,
  decline: 2,
  done: 3,
  vote: 4,
  setChannelParams: 5,
} as const;

/** The single payload byte of a vote. */
export const TASK_CHOICE = { done: 0, notDone: 1 } as const;

/** DOMAIN ‖ lp(chain) ‖ lp(canister_id) ‖ lp(task_id) ‖ action ‖ lp(payload) */
export function taskMessage(
  chain: string,
  canisterId: Uint8Array,
  taskId: Uint8Array,
  action: number,
  payload: Uint8Array,
): Uint8Array {
  return concat(utf8(TASKS_DOMAIN), lp(utf8(chain)), lp(canisterId), lp(taskId), u8(action), lp(payload));
}

/** lp(text_hash) ‖ duration_le — the two facts the task_id does not notarize. */
export function registerPayload(textHash: Uint8Array, duration: bigint): Uint8Array {
  return concat(lp(textHash), u64le(duration));
}

/** DOMAIN ‖ lp(chain) ‖ lp(canister_id) ‖ 5 ‖ lp(streamer) ‖ min_gross_le ‖ min_reputation_le ‖ enabled ‖ counter_le */
export function channelMessage(
  chain: string,
  canisterId: Uint8Array,
  streamer: Uint8Array,
  minGross: bigint,
  minReputation: bigint,
  enabled: boolean,
  counter: bigint,
): Uint8Array {
  return concat(
    utf8(TASKS_DOMAIN),
    lp(utf8(chain)),
    lp(canisterId),
    u8(TASK_ACTION.setChannelParams),
    lp(streamer),
    u64le(minGross),
    u128le(minReputation),
    u8(enabled ? 1 : 0),
    u64le(counter),
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
