// Birth salts of the two escrow shapes the games use. This is the fourth
// implementation of these byte formats after the deployed programs,
// crown-salt and the canisters — so it is never edited by eye:
//
//   stream       — vectors/stream-salt.json, a byte copy of the factory's
//                  fixtures (scripts/lint-vectors.sh pins the copy), which
//                  are themselves cross-checked there against python and the
//                  on-chain birth_salt.
//   two-outcome  — the factory has no vector file for this shape; the
//                  reference vector lives in Crown-Factory/salt/src/
//                  two_outcome.rs and is pinned in test/salt.test.ts.
//
// A one-byte drift derives an address where no escrow will ever live, so the
// live proof is the strongest one: the program recomputes the salt itself and
// inits the account at its own PDA — a mismatched declaration cannot even
// create an escrow.

import { sha256 } from "@noble/hashes/sha2.js";

import { assertLength, concat, i64le, u16le, u64le } from "./bytes.ts";

/** Birth fields of a two-outcome escrow: Tasks, Funding and Auction use this shape. */
export interface TwoOutcomeBirth {
  donor: Uint8Array;
  /** The single recipient of a settle. */
  recipient: Uint8Array;
  gross: bigint;
  deadline: bigint;
  resolver: Uint8Array;
  /** The game's price tag — birth fields like the rest. */
  feeBps: number;
  feeWallet: Uint8Array;
  nonce: bigint;
}

/**
 * salt = sha256(donor ‖ recipient ‖ gross_le ‖ deadline_le ‖ resolver ‖
 * fee_bps_le ‖ fee_wallet ‖ nonce_le)
 */
export function twoOutcomeSalt(birth: TwoOutcomeBirth): Uint8Array {
  assertLength(birth.donor, 32, "donor");
  assertLength(birth.recipient, 32, "recipient");
  assertLength(birth.resolver, 32, "resolver");
  assertLength(birth.feeWallet, 32, "feeWallet");
  return sha256(
    concat(
      birth.donor,
      birth.recipient,
      u64le(birth.gross),
      i64le(birth.deadline),
      birth.resolver,
      u16le(birth.feeBps),
      birth.feeWallet,
      u64le(birth.nonce),
    ),
  );
}

/** Birth fields of a stream escrow: the Subscription game's shape. */
export interface StreamBirth {
  donor: Uint8Array;
  recipients: Uint8Array[];
  /** Ten-thousandths of the chunk, one share per recipient. */
  shares: number[];
  chunk: bigint;
  nChunks: number;
  t0: bigint;
  period: bigint;
  resolver: Uint8Array;
  feeBps: number;
  feeWallet: Uint8Array;
  nonce: bigint;
}

/**
 * salt = sha256(donor ‖ K(u8) ‖ recipients ‖ shares(u16 LE) ‖ chunk_le ‖
 * n_chunks_le ‖ t0_le ‖ period_le ‖ resolver ‖ fee_bps_le ‖ fee_wallet ‖
 * nonce_le). K prefixes the recipients and pins the shares length too.
 */
export function streamSalt(birth: StreamBirth): Uint8Array {
  assertLength(birth.donor, 32, "donor");
  assertLength(birth.resolver, 32, "resolver");
  assertLength(birth.feeWallet, 32, "feeWallet");
  const parts: Uint8Array[] = [birth.donor, new Uint8Array([birth.recipients.length])];
  for (const recipient of birth.recipients) {
    assertLength(recipient, 32, "recipient");
    parts.push(recipient);
  }
  for (const share of birth.shares) {
    parts.push(u16le(share));
  }
  parts.push(u64le(birth.chunk));
  parts.push(u16le(birth.nChunks));
  parts.push(i64le(birth.t0));
  parts.push(i64le(birth.period));
  parts.push(birth.resolver);
  parts.push(u16le(birth.feeBps));
  parts.push(birth.feeWallet);
  parts.push(u64le(birth.nonce));
  return sha256(concat(...parts));
}
