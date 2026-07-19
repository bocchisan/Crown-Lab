// Instruction builders: the splitter's donate, and the two escrow shapes the
// games use. Account lists mirror the deployed programs' Accounts structs in
// order — a swapped account is a failed transaction at best and a wrong
// settlement at worst, so the order here is copied from the source, never
// guessed. Discriminators are pinned; test/ix.test.ts recomputes them from
// sha256("global:<name>").
//
// The payout-table shape is deliberately absent: no game uses it, so nothing
// here would have a consumer.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { concat, fromHex, i64le, u8, u16le, u32le, u64le, utf8 } from "./bytes.ts";
import type { StreamEscrow, TwoOutcomeEscrow } from "./escrow.ts";
import { streamAddress, twoOutcomeAddress } from "./escrow.ts";
import type { StreamBirth, TwoOutcomeBirth } from "./salt.ts";

/** sha256("global:<name>")[..8]. */
export const DISCRIMINATORS = {
  donate: fromHex("79badad34946c4b4"),
  createEscrow: fromHex("fdd7a574246c4450"),
  claim: fromHex("3ec6d6c1d59f6cd2"),
  release: fromHex("fdf90fce1c7fc1f1"),
  cancel: fromHex("e8dbdf29dbecdcbe"),
  refund: fromHex("0260b7fb3fd02e2e"),
} as const;

export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");

/** The chain's fixed addresses, from config. */
export interface ChainAddresses {
  splitter: PublicKey;
  usdc: PublicKey;
  factoryTwoOutcome: PublicKey;
  factoryStream: PublicKey;
}

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  // Escrows are PDAs — off the curve is expected.
  return getAssociatedTokenAddressSync(mint, owner, true);
}

/** Idempotent ATA creation: recipients may have no USDC account yet. */
export function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);
}

function splitterEventAuthority(splitter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("__event_authority")], splitter)[0];
}

/**
 * The ed25519_program instruction the shapes demand directly before a
 * claim/release/cancel: one self-contained signature entry, every offset
 * pointing into this instruction itself (header 16 bytes: pubkey at 16,
 * signature at 48, message at 112).
 */
export function ed25519VerifyIx(
  resolver: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  const data = concat(
    new Uint8Array([1, 0]),
    u16le(48),
    u16le(0xffff),
    u16le(16),
    u16le(0xffff),
    u16le(112),
    u16le(message.length),
    u16le(0xffff),
    resolver,
    signature,
    message,
  );
  return new TransactionInstruction({ programId: ED25519_PROGRAM_ID, keys: [], data: Buffer.from(data) });
}

// ---- splitter -------------------------------------------------------------

/**
 * donate(gross): the whole amount straight from the payer to the recipient,
 * plus the Settled event the book reads. No fee, no custody.
 */
export function donateIx(
  payer: PublicKey,
  recipient: PublicKey,
  gross: bigint,
  chain: ChainAddresses,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: chain.splitter,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(payer, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: ata(recipient, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: splitterEventAuthority(chain.splitter), isSigner: false, isWritable: false },
      { pubkey: chain.splitter, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISCRIMINATORS.donate, u64le(gross))),
  });
}

// ---- two-outcome (Tasks, Funding) -----------------------------------------

/** create_escrow: births the escrow and funds it with the whole gross. */
export function twoOutcomeCreateIx(
  birth: TwoOutcomeBirth,
  chain: ChainAddresses,
): { instruction: TransactionInstruction; escrow: PublicKey } {
  const factory = chain.factoryTwoOutcome;
  const escrow = twoOutcomeAddress(birth, factory);
  const donor = new PublicKey(birth.donor);
  const data = concat(
    DISCRIMINATORS.createEscrow,
    u64le(birth.gross),
    i64le(birth.deadline),
    birth.resolver,
    u16le(birth.feeBps),
    birth.feeWallet,
    u64le(birth.nonce),
  );
  const instruction = new TransactionInstruction({
    programId: factory,
    keys: [
      { pubkey: donor, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(birth.recipient), isSigner: false, isWritable: false },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
  return { instruction, escrow };
}

/**
 * claim(outcome): settle (0) pays the recipient through the splitter net of
 * the escrow's fee; cancel (1) returns everything to the donor. Permissionless
 * — the resolver's signature in the preceding ed25519 instruction is the whole
 * authority, so anyone may pay the gas.
 */
export function twoOutcomeClaimIx(
  escrow: PublicKey,
  state: Pick<TwoOutcomeEscrow, "donor" | "recipient" | "feeWallet">,
  outcome: number,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  const recipient = new PublicKey(state.recipient);
  // The fee goes to the ATA of the wallet the escrow itself was born with;
  // the program pins the address, this list only supplies it.
  const feeWallet = new PublicKey(state.feeWallet);
  return new TransactionInstruction({
    programId: chain.factoryTwoOutcome,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: donor, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: ata(recipient, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: ata(feeWallet, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: splitterEventAuthority(chain.splitter), isSigner: false, isWritable: false },
      { pubkey: chain.splitter, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISCRIMINATORS.claim, u8(outcome))),
  });
}

/** refund(): the dead-resolver insurance, strictly after the deadline. No signature. */
export function twoOutcomeRefundIx(
  escrow: PublicKey,
  state: Pick<TwoOutcomeEscrow, "donor">,
  chain: ChainAddresses,
): TransactionInstruction {
  return refundLike(escrow, new PublicKey(state.donor), chain.factoryTwoOutcome, chain);
}

// ---- stream (Subscription) -------------------------------------------------

/** create_escrow: births the stream and funds it with chunk × n_chunks. */
export function streamCreateIx(
  birth: StreamBirth,
  chain: ChainAddresses,
): { instruction: TransactionInstruction; escrow: PublicKey } {
  const factory = chain.factoryStream;
  const escrow = streamAddress(birth, factory);
  const donor = new PublicKey(birth.donor);
  const data = concat(
    DISCRIMINATORS.createEscrow,
    u32le(birth.recipients.length),
    ...birth.recipients,
    u32le(birth.shares.length),
    ...birth.shares.map(u16le),
    u64le(birth.chunk),
    u16le(birth.nChunks),
    i64le(birth.t0),
    i64le(birth.period),
    birth.resolver,
    u16le(birth.feeBps),
    birth.feeWallet,
    u64le(birth.nonce),
  );
  const instruction = new TransactionInstruction({
    programId: factory,
    keys: [
      { pubkey: donor, isSigner: true, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
  return { instruction, escrow };
}

/**
 * release(index): one chunk through the splitter. Pairs of [recipient,
 * recipient ATA] follow the fixed accounts in birth order, one pair per
 * nonzero share.
 */
export function streamReleaseIx(
  escrow: PublicKey,
  state: Pick<StreamEscrow, "donor" | "recipients" | "shares" | "feeWallet">,
  index: number,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  const feeWallet = new PublicKey(state.feeWallet);
  const keys = [
    { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: chain.usdc, isSigner: false, isWritable: false },
    { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: donor, isSigner: false, isWritable: true },
    { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: ata(feeWallet, chain.usdc), isSigner: false, isWritable: true },
    { pubkey: splitterEventAuthority(chain.splitter), isSigner: false, isWritable: false },
    { pubkey: chain.splitter, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  state.recipients.forEach((recipient, position) => {
    if (state.shares[position] === 0) return;
    const wallet = new PublicKey(recipient);
    keys.push({ pubkey: wallet, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(wallet, chain.usdc), isSigner: false, isWritable: true });
  });
  return new TransactionInstruction({
    programId: chain.factoryStream,
    keys,
    data: Buffer.from(concat(DISCRIMINATORS.release, u16le(index))),
  });
}

/** cancel(): the whole unreleased remainder back to the donor. Terminal. */
export function streamCancelIx(
  escrow: PublicKey,
  state: Pick<StreamEscrow, "donor">,
  chain: ChainAddresses,
): TransactionInstruction {
  const donor = new PublicKey(state.donor);
  return new TransactionInstruction({
    programId: chain.factoryStream,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: donor, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.cancel),
  });
}

/** refund(): available once the next chunk is overdue by RELEASE_MARGIN. */
export function streamRefundIx(
  escrow: PublicKey,
  state: Pick<StreamEscrow, "donor">,
  chain: ChainAddresses,
): TransactionInstruction {
  return refundLike(escrow, new PublicKey(state.donor), chain.factoryStream, chain);
}

/** Both shapes' refund take the same six accounts and carry no arguments. */
function refundLike(
  escrow: PublicKey,
  donor: PublicKey,
  factory: PublicKey,
  chain: ChainAddresses,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: factory,
    keys: [
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: chain.usdc, isSigner: false, isWritable: false },
      { pubkey: ata(escrow, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: donor, isSigner: false, isWritable: true },
      { pubkey: ata(donor, chain.usdc), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.refund),
  });
}
