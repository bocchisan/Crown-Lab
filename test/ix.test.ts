// Instruction builders: discriminators recomputed from their definition, and
// account lists checked in order against the deployed programs' Accounts
// structs. A swapped account is the failure mode this file exists to catch.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256 } from "@noble/hashes/sha2.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";

import { concat, hex, u8, u16le, u64le, utf8 } from "../src/bytes.ts";
import {
  type ChainAddresses,
  DISCRIMINATORS,
  ED25519_PROGRAM_ID,
  ata,
  donateIx,
  ed25519VerifyIx,
  streamCreateIx,
  streamReleaseIx,
  twoOutcomeClaimIx,
  twoOutcomeCreateIx,
} from "../src/ix.ts";

const chain: ChainAddresses = {
  splitter: new PublicKey("DDSeyx684iU9agHbXExwS3NstLvQeLKZcJWcJFSh1VDA"),
  usdc: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  factoryTwoOutcome: new PublicKey("83f7ziVs5VeQ8xiDka8zczbfJT4WcxsXQ18cqWwmV5ur"),
  factoryStream: new PublicKey("57MpCQ3TfAE66qDAnfkP9AX7LRqwd4CNX8uN6DaVwm3V"),
};

const donor = new PublicKey("2b6JQquqQDsS8o3DFDiaxFLKTFMro1YrvVq7aimV4FzD");
const streamer = new PublicKey("Gt381v8RqGQUX7vdRbC9NdZCzGuzk6ZUgcTDLfUnYdcJ");
const feeWallet = new PublicKey("3it64t7KXNip1C1BRYNh8ygeKyujWnaQrPSj3hV9TWbE");

test("discriminators are sha256(\"global:<name>\")[..8]", () => {
  const of = (name: string) => hex(sha256(utf8(`global:${name}`)).slice(0, 8));
  assert.equal(hex(DISCRIMINATORS.donate), of("donate"));
  assert.equal(hex(DISCRIMINATORS.createEscrow), of("create_escrow"));
  assert.equal(hex(DISCRIMINATORS.claim), of("claim"));
  assert.equal(hex(DISCRIMINATORS.release), of("release"));
  assert.equal(hex(DISCRIMINATORS.cancel), of("cancel"));
  assert.equal(hex(DISCRIMINATORS.refund), of("refund"));
});

/**
 * The ed25519 record is self-contained: pubkey at 16, signature at 48, message
 * at 112, and all three instruction-index fields are 0xffff (this instruction
 * itself). The shapes read exactly these offsets and refuse anything else.
 */
test("ed25519 verify instruction is self-contained", () => {
  const message = new Uint8Array(96).fill(0x07);
  const resolver = new Uint8Array(32).fill(0x01);
  const signature = new Uint8Array(64).fill(0x02);
  const ix = ed25519VerifyIx(resolver, signature, message);
  const data = new Uint8Array(ix.data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  assert.equal(ix.programId.toBase58(), ED25519_PROGRAM_ID.toBase58());
  assert.equal(ix.keys.length, 0, "the record carries no accounts");
  assert.equal(data[0], 1, "exactly one signature entry");
  assert.equal(view.getUint16(2, true), 48);
  assert.equal(view.getUint16(4, true), 0xffff);
  assert.equal(view.getUint16(6, true), 16);
  assert.equal(view.getUint16(8, true), 0xffff);
  assert.equal(view.getUint16(10, true), 112);
  assert.equal(view.getUint16(12, true), message.length);
  assert.equal(view.getUint16(14, true), 0xffff);
  assert.equal(hex(data.slice(16, 48)), hex(resolver));
  assert.equal(hex(data.slice(48, 112)), hex(signature));
  assert.equal(hex(data.slice(112)), hex(message));
  assert.equal(data.length, 112 + message.length);
});

// The splitter's Donate accounts, in the order the program declares them;
// event_authority and program come last, appended by #[event_cpi].
test("donate names the splitter accounts in order", () => {
  const ix = donateIx(donor, streamer, 100_000n, chain);
  const eventAuthority = PublicKey.findProgramAddressSync([utf8("__event_authority")], chain.splitter)[0];
  assert.deepEqual(
    ix.keys.map((key) => key.pubkey.toBase58()),
    [
      donor.toBase58(),
      streamer.toBase58(),
      chain.usdc.toBase58(),
      ata(donor, chain.usdc).toBase58(),
      ata(streamer, chain.usdc).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      eventAuthority.toBase58(),
      chain.splitter.toBase58(),
    ],
  );
  assert.equal(ix.keys[0]?.isSigner, true, "only the payer signs");
  assert.equal(hex(new Uint8Array(ix.data)), hex(concat(DISCRIMINATORS.donate, u64le(100_000n))));
});

test("two-outcome create carries the birth fields in borsh order", () => {
  const birth = {
    donor: donor.toBytes(),
    streamer: streamer.toBytes(),
    gross: 30_000n,
    deadline: 1_900_000_000n,
    resolver: new Uint8Array(32).fill(0x33),
    feeBps: 300,
    feeWallet: feeWallet.toBytes(),
    nonce: 7n,
  };
  const { instruction, escrow } = twoOutcomeCreateIx(birth, chain);
  assert.equal(
    hex(new Uint8Array(instruction.data)),
    hex(
      concat(
        DISCRIMINATORS.createEscrow,
        u64le(30_000n),
        new Uint8Array(new BigInt64Array([1_900_000_000n]).buffer),
        birth.resolver,
        u16le(300),
        birth.feeWallet,
        u64le(7n),
      ),
    ),
  );
  assert.deepEqual(
    instruction.keys.map((key) => key.pubkey.toBase58()),
    [
      donor.toBase58(),
      streamer.toBase58(),
      chain.usdc.toBase58(),
      escrow.toBase58(),
      ata(donor, chain.usdc).toBase58(),
      ata(escrow, chain.usdc).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").toBase58(),
      PublicKey.default.toBase58(),
    ],
  );
});

// Claim's twelve accounts in the program's order. The fee ATA belongs to the
// wallet the escrow was born with, never to one the caller picks.
test("two-outcome claim names twelve accounts in order", () => {
  const escrow = new PublicKey("CszaaibvYybHEURAWc297DGg7wCF5NXQ7196dAQJsw7y");
  const ix = twoOutcomeClaimIx(
    escrow,
    { donor: donor.toBytes(), streamer: streamer.toBytes(), feeWallet: feeWallet.toBytes() },
    0,
    chain,
  );
  const eventAuthority = PublicKey.findProgramAddressSync([utf8("__event_authority")], chain.splitter)[0];
  assert.deepEqual(
    ix.keys.map((key) => key.pubkey.toBase58()),
    [
      escrow.toBase58(),
      chain.usdc.toBase58(),
      ata(escrow, chain.usdc).toBase58(),
      donor.toBase58(),
      ata(donor, chain.usdc).toBase58(),
      streamer.toBase58(),
      ata(streamer, chain.usdc).toBase58(),
      ata(feeWallet, chain.usdc).toBase58(),
      eventAuthority.toBase58(),
      chain.splitter.toBase58(),
      SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  assert.equal(ix.keys.every((key) => !key.isSigner), true, "claim needs no signer but the fee payer");
  assert.equal(hex(new Uint8Array(ix.data)), hex(concat(DISCRIMINATORS.claim, u8(0))));
});

// Release: ten fixed accounts, then one [recipient, ATA] pair per nonzero
// share, in birth order. A zero share contributes no pair.
test("stream release appends a pair per nonzero share", () => {
  const escrow = new PublicKey("CS1mmfBkPLimY6WLGczafmQBiQNUKTUmQrCfDBKUJEyz");
  const second = new PublicKey("ByQ5SXVFXM1zJRg5vDztqs4ZdRdRSSBgvoWvMAw5Rgcx");
  const state = {
    donor: donor.toBytes(),
    recipients: [streamer.toBytes(), second.toBytes()],
    shares: [7000, 0],
    feeWallet: feeWallet.toBytes(),
  };
  const ix = streamReleaseIx(escrow, state, 1, chain);
  assert.equal(ix.keys.length, 12, "ten fixed + one pair; the zero share adds none");
  assert.equal(ix.keys[10]?.pubkey.toBase58(), streamer.toBase58());
  assert.equal(ix.keys[10]?.isWritable, false, "the recipient wallet is read-only");
  assert.equal(ix.keys[11]?.pubkey.toBase58(), ata(streamer, chain.usdc).toBase58());
  assert.equal(ix.keys[11]?.isWritable, true, "its ATA receives");
  assert.equal(hex(new Uint8Array(ix.data)), hex(concat(DISCRIMINATORS.release, u16le(1))));

  const both = streamReleaseIx(escrow, { ...state, shares: [7000, 3000] }, 1, chain);
  assert.equal(both.keys.length, 14);
});

test("stream create carries the vectors with u32 length prefixes", () => {
  const birth = {
    donor: donor.toBytes(),
    recipients: [streamer.toBytes()],
    shares: [10_000],
    chunk: 40_000n,
    nChunks: 3,
    t0: 1_784_111_832n,
    period: 45n,
    resolver: new Uint8Array(32).fill(0x33),
    feeBps: 300,
    feeWallet: feeWallet.toBytes(),
    nonce: 1_784_111_832n,
  };
  const { instruction } = streamCreateIx(birth, chain);
  const data = new Uint8Array(instruction.data);
  // Discriminator, then u32(K)=1 — borsh frames the vector, unlike the salt
  // where K is a single byte. The two must not be confused.
  assert.equal(hex(data.slice(0, 8)), hex(DISCRIMINATORS.createEscrow));
  assert.equal(hex(data.slice(8, 12)), "01000000");
  assert.equal(hex(data.slice(12, 44)), hex(streamer.toBytes()));
  assert.equal(hex(data.slice(44, 48)), "01000000", "shares vector is framed too");
  assert.equal(hex(data.slice(48, 50)), hex(u16le(10_000)));
});
