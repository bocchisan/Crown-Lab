// Escrow addresses and account decoders of both shapes.
//
// The address is PDA([b"escrow", salt], factory) for every shape — the same
// arithmetic the core's indexer (crown-derive) and the game canisters run.
// The header convention (factory-spec §2.1) fixes donor at 8..40 and salt at
// 40..72 for every shape; past the header the layouts diverge.

import { PublicKey } from "@solana/web3.js";

import { bytesEqual, utf8 } from "./bytes.ts";
import { type StreamBirth, type TwoOutcomeBirth, streamSalt, twoOutcomeSalt } from "./salt.ts";

/** sha256("account:Escrow")[..8] — shared by all three shapes. */
export const ESCROW_DISCRIMINATOR = new Uint8Array([31, 213, 123, 187, 186, 22, 218, 155]);

export const DONOR_OFFSET = 8;
export const SALT_OFFSET = 40;

export function escrowAddress(salt: Uint8Array, factory: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("escrow"), salt], factory)[0];
}

export function twoOutcomeAddress(birth: TwoOutcomeBirth, factory: PublicKey): PublicKey {
  return escrowAddress(twoOutcomeSalt(birth), factory);
}

export function streamAddress(birth: StreamBirth, factory: PublicKey): PublicKey {
  return escrowAddress(streamSalt(birth), factory);
}

/** Sequential reader over one account's bytes; refuses to read past the end. */
class Reader {
  private offset: number;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.offset = DONOR_OFFSET;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  bytes(length: number): Uint8Array {
    const part = this.data.slice(this.offset, this.offset + length);
    if (part.length !== length) throw new Error("truncated escrow account");
    this.offset += length;
    return part;
  }

  pubkey(): Uint8Array {
    return this.bytes(32);
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }
}

function reader(data: Uint8Array, shape: string): Reader {
  if (!bytesEqual(data.slice(0, 8), ESCROW_DISCRIMINATOR)) {
    throw new Error(`not a ${shape} Escrow account`);
  }
  return new Reader(data);
}

export interface TwoOutcomeEscrow {
  donor: Uint8Array;
  salt: Uint8Array;
  recipient: Uint8Array;
  resolver: Uint8Array;
  gross: bigint;
  deadline: bigint;
  feeBps: number;
  feeWallet: Uint8Array;
  bump: number;
  /** Terminal: claimed with either outcome, or refunded. */
  settled: boolean;
}

/** two-outcome Escrow: 188 bytes, fixed. */
export function decodeTwoOutcome(data: Uint8Array): TwoOutcomeEscrow {
  const r = reader(data, "two-outcome");
  return {
    donor: r.pubkey(),
    salt: r.bytes(32),
    recipient: r.pubkey(),
    resolver: r.pubkey(),
    gross: r.u64(),
    deadline: r.i64(),
    feeBps: r.u16(),
    feeWallet: r.pubkey(),
    bump: r.u8(),
    settled: r.bool(),
  };
}

export interface StreamEscrow {
  donor: Uint8Array;
  salt: Uint8Array;
  resolver: Uint8Array;
  chunk: bigint;
  nChunks: number;
  /** Chunks released so far; also the index of the next chunk due. */
  released: number;
  t0: bigint;
  period: bigint;
  feeBps: number;
  feeWallet: Uint8Array;
  bump: number;
  /** Terminal: cancel, refund, or the last chunk released. */
  settled: boolean;
  recipients: Uint8Array[];
  shares: number[];
}

/** stream Escrow: fixed head, then the recipient and share vectors. */
export function decodeStream(data: Uint8Array): StreamEscrow {
  const r = reader(data, "stream");
  const head = {
    donor: r.pubkey(),
    salt: r.bytes(32),
    resolver: r.pubkey(),
    chunk: r.u64(),
    nChunks: r.u16(),
    released: r.u16(),
    t0: r.i64(),
    period: r.i64(),
    feeBps: r.u16(),
    feeWallet: r.pubkey(),
    bump: r.u8(),
    settled: r.bool(),
  };
  const recipients: Uint8Array[] = [];
  for (let count = r.u32(); count > 0; count--) recipients.push(r.pubkey());
  const shares: number[] = [];
  for (let count = r.u32(); count > 0; count--) shares.push(r.u16());
  return { ...head, recipients, shares };
}

/** The next chunk is due once now >= t0 + index*period (schedule.rs). */
export function chunkDueAt(escrow: StreamEscrow, index: number): bigint {
  return escrow.t0 + BigInt(index) * escrow.period;
}

/**
 * A settled escrow is terminal: the settlement swept and closed its USDC
 * account, so anything sent at it now dies deep inside the program with
 * "AccountNotInitialized: escrow_usdc" — a true statement about an account
 * nobody mentioned, and a useless one to read. Say the real thing instead.
 */
export function refuseIfSettled(escrow: { settled: boolean }, what: string): void {
  if (escrow.settled) {
    throw new Error(
      `${what}: эскроу уже рассчитан (settled) — деньги ушли первым расчётом, второй раз двигать нечего`,
    );
  }
}
