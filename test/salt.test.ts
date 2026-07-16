// The salts and the addresses they derive. These are the tests that matter:
// this repository holds the fourth copy of these byte formats, and a copy
// that drifts by one byte silently addresses escrows that will never exist.
//
// Sources of truth, none of them this file:
//   stream       — vectors/stream-salt.json, a byte copy of the factory's
//                  fixtures (scripts/lint-vectors.sh proves the copy);
//   two-outcome  — the reference vector in Crown-Factory/salt/src/
//                  two_outcome.rs, which the canisters pin too;
//   PDA          — vectors/solana.json, the factory's own derivation vectors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PublicKey } from "@solana/web3.js";

import { fromHex, hex } from "../src/bytes.ts";
import { escrowAddress } from "../src/escrow.ts";
import { type StreamBirth, streamSalt, twoOutcomeSalt } from "../src/salt.ts";

interface StreamVector {
  donor_hex: string;
  recipients_hex: string[];
  shares: number[];
  chunk: string;
  n_chunks: string;
  t0: string;
  period: string;
  resolver_hex: string;
  fee_bps: number;
  fee_wallet_hex: string;
  nonce: string;
  salt_hex: string;
}

/**
 * JSON loses precision past 2^53 and these vectors deliberately carry u64::MAX
 * and i64::MIN-ish values, so the big fields are quoted before parsing.
 */
function loadVectors<T>(path: string, bigFields: string[]): T[] {
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  const quoted = raw.replace(
    new RegExp(`"(${bigFields.join("|")})": (-?\\d+)`, "g"),
    '"$1": "$2"',
  );
  return JSON.parse(quoted) as T[];
}

test("stream salt matches every factory vector", () => {
  const vectors = loadVectors<StreamVector>("../vectors/stream-salt.json", [
    "chunk",
    "n_chunks",
    "t0",
    "period",
    "nonce",
  ]);
  assert.ok(vectors.length >= 4, "vector file must not be empty");
  for (const vector of vectors) {
    const birth: StreamBirth = {
      donor: fromHex(vector.donor_hex),
      recipients: vector.recipients_hex.map(fromHex),
      shares: vector.shares,
      chunk: BigInt(vector.chunk),
      nChunks: Number(vector.n_chunks),
      t0: BigInt(vector.t0),
      period: BigInt(vector.period),
      resolver: fromHex(vector.resolver_hex),
      feeBps: vector.fee_bps,
      feeWallet: fromHex(vector.fee_wallet_hex),
      nonce: BigInt(vector.nonce),
    };
    assert.equal(hex(streamSalt(birth)), vector.salt_hex);
  }
});

// The two-outcome reference vector: Crown-Factory/salt/src/two_outcome.rs,
// where it is checked against the deployed program's birth_salt by a 512-case
// fuzz. The canisters of Tasks and Funding pin the same bytes.
test("two-outcome salt matches the reference vector", () => {
  const salt = twoOutcomeSalt({
    donor: new Uint8Array(32).fill(0x11),
    streamer: new Uint8Array(32).fill(0x22),
    gross: 1_000_000n,
    deadline: 1_900_000_000n,
    resolver: new Uint8Array(32).fill(0x33),
    feeBps: 500,
    feeWallet: new Uint8Array(32).fill(0x44),
    nonce: 7n,
  });
  assert.equal(hex(salt), "149c82b09a080ef4c92921d13d974177bfea2dd546ef8b798627e3e4245afe6b");
});

// Every birth field must split the salt: two different births may never share
// an address, or one escrow would answer to two declarations.
test("every two-outcome birth field separates the salt", () => {
  const base = {
    donor: new Uint8Array(32).fill(0x11),
    streamer: new Uint8Array(32).fill(0x22),
    gross: 1_000_000n,
    deadline: 1_900_000_000n,
    resolver: new Uint8Array(32).fill(0x33),
    feeBps: 500,
    feeWallet: new Uint8Array(32).fill(0x44),
    nonce: 7n,
  };
  const mutations = [
    { ...base, donor: new Uint8Array(32).fill(0x12) },
    { ...base, streamer: new Uint8Array(32).fill(0x23) },
    { ...base, gross: 1_000_001n },
    { ...base, deadline: 1_900_000_001n },
    { ...base, resolver: new Uint8Array(32).fill(0x34) },
    { ...base, feeBps: 501 },
    { ...base, feeWallet: new Uint8Array(32).fill(0x45) },
    { ...base, nonce: 8n },
  ];
  const salts = new Set([hex(twoOutcomeSalt(base)), ...mutations.map((m) => hex(twoOutcomeSalt(m)))]);
  assert.equal(salts.size, mutations.length + 1);
});

// A field of the wrong length must throw rather than hash something else:
// silent truncation would derive a plausible, wrong address.
test("salts refuse fields of the wrong length", () => {
  assert.throws(() =>
    twoOutcomeSalt({
      donor: new Uint8Array(31),
      streamer: new Uint8Array(32),
      gross: 1n,
      deadline: 1n,
      resolver: new Uint8Array(32),
      feeBps: 0,
      feeWallet: new Uint8Array(32),
      nonce: 0n,
    }),
  );
});

interface PdaVector {
  program: string;
  seeds_hex: string[];
  pda: string;
}

// The escrow address is PDA([b"escrow", salt], factory) for every shape.
test("escrow address matches the factory's PDA vectors", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../vectors/solana.json", import.meta.url), "utf8"),
  ) as PdaVector[];
  assert.ok(vectors.length > 0);
  for (const vector of vectors) {
    const [seed, salt] = vector.seeds_hex;
    assert.ok(seed && salt);
    // The first seed is the literal b"escrow" the shapes use.
    assert.equal(Buffer.from(fromHex(seed)).toString("utf8"), "escrow");
    const address = escrowAddress(fromHex(salt), new PublicKey(vector.program));
    assert.equal(address.toBase58(), vector.pda);
  }
});
