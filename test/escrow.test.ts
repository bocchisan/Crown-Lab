// The account decoders, against real devnet escrows born by the deployed v2
// factories — the same accounts crown-index pins as its own fixtures.
//
// The strongest check here needs no network: each fixture stores its birth
// salt, and every salt input except the nonce is a field of the account. So
// the salt is recomputed from the account's own decoded fields plus the one
// pinned nonce, and must reproduce the stored bytes exactly. That proves the
// decoder offsets, the salt formula and the PDA arithmetic against a program
// that actually minted this account.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PublicKey } from "@solana/web3.js";

import { hex } from "../src/bytes.ts";
import { decodeStream, decodeTwoOutcome, escrowAddress } from "../src/escrow.ts";
import { streamSalt, twoOutcomeSalt } from "../src/salt.ts";

interface Fixture {
  address: string;
  owner: string;
  note: string;
  data_base64: string;
}

function fixture(name: string): { account: Uint8Array; address: PublicKey; owner: PublicKey } {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
  return {
    account: new Uint8Array(Buffer.from(parsed.data_base64.trim(), "base64")),
    address: new PublicKey(parsed.address),
    owner: new PublicKey(parsed.owner),
  };
}

// The nonce is the only birth field an escrow does not store. These two are
// recovered from the fixtures themselves (the factory's driver takes the unix
// clock; the stream client convention is nonce = t0) and pinned here.
const TWO_OUTCOME_NONCE = 1_784_111_901n;

test("two-outcome escrow decodes and its salt reproduces from its own fields", () => {
  const { account, address, owner } = fixture("two-outcome-escrow.json");
  const escrow = decodeTwoOutcome(account);

  assert.equal(account.length, 188, "the shape's account is fixed-size");
  assert.equal(escrow.gross, 50_000n);
  assert.equal(escrow.feeBps, 500);
  assert.equal(escrow.settled, true);
  assert.equal(escrow.bump, 255);
  assert.equal(
    new PublicKey(escrow.donor).toBase58(),
    "2b6JQquqQDsS8o3DFDiaxFLKTFMro1YrvVq7aimV4FzD",
    "donor at 8..40 — the header convention the whole platform reads",
  );

  const salt = twoOutcomeSalt({
    donor: escrow.donor,
    recipient: escrow.recipient,
    gross: escrow.gross,
    deadline: escrow.deadline,
    resolver: escrow.resolver,
    feeBps: escrow.feeBps,
    feeWallet: escrow.feeWallet,
    nonce: TWO_OUTCOME_NONCE,
  });
  assert.equal(hex(salt), hex(escrow.salt), "the salt this program actually stored");
  assert.equal(escrowAddress(salt, owner).toBase58(), address.toBase58(), "PDA re-derives the account");
});

test("stream escrow decodes and its salt reproduces from its own fields", () => {
  const { account, address, owner } = fixture("stream-escrow.json");
  const escrow = decodeStream(account);

  assert.equal(escrow.chunk, 100_000n);
  assert.equal(escrow.nChunks, 3);
  assert.equal(escrow.released, 2);
  assert.equal(escrow.period, 15n);
  assert.equal(escrow.feeBps, 500);
  assert.equal(escrow.settled, true);
  assert.deepEqual(escrow.shares, [7000, 3000]);
  assert.equal(escrow.recipients.length, 2);

  const salt = streamSalt({
    donor: escrow.donor,
    recipients: escrow.recipients,
    shares: escrow.shares,
    chunk: escrow.chunk,
    nChunks: escrow.nChunks,
    t0: escrow.t0,
    period: escrow.period,
    resolver: escrow.resolver,
    feeBps: escrow.feeBps,
    feeWallet: escrow.feeWallet,
    // The client convention: nonce = t0, so a birth is recoverable from one
    // account read (docs/bot-spec.md §6).
    nonce: BigInt.asUintN(64, escrow.t0),
  });
  assert.equal(hex(salt), hex(escrow.salt));
  assert.equal(escrowAddress(salt, owner).toBase58(), address.toBase58());
});

// Both shapes share the discriminator, so a stream account must not decode as
// a two-outcome one by accident: the length and the fields differ, and reading
// the wrong shape would print a plausible lie.
test("decoders refuse foreign account data", () => {
  const stranger = new Uint8Array(200);
  assert.throws(() => decodeTwoOutcome(stranger), /not a two-outcome Escrow account/);
  assert.throws(() => decodeStream(stranger), /not a stream Escrow account/);
  // Truncated data must throw rather than read garbage past the end.
  const { account } = fixture("stream-escrow.json");
  assert.throws(() => decodeStream(account.slice(0, 100)), /truncated escrow account/);
});
