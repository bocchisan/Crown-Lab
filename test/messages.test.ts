// Every message layout, pinned byte for byte against the canisters' own unit
// tests (each game's canister/src/auth.rs) and the shapes' verdict format.
// The expected bytes are spelled out here exactly as the Rust tests spell
// them: a layout that drifts is a signature no canister will accept.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Message, PublicKey, VersionedMessage } from "@solana/web3.js";

import { concat, hex, lp, u8, u16le, u32le, u64le, utf8 } from "../src/bytes.ts";
import {
  TASK_CHOICE,
  FUNDING_ACTION,
  FUNDING_CHOICE,
  cancelAuthorization,
  cancelMessage,
  channelMessage,
  collectionId,
  collectionMessage,
  createPayload,
  releaseMessage,
  taskMessage,
  twoOutcomeVerdictMessage,
} from "../src/messages.ts";

// The canister's own unit vectors (Conditional-Tasks canister/src/auth.rs:
// accept_message_is_pinned, register_message_is_pinned, vote_message_is_pinned,
// channel_message_is_pinned). If these two ever disagree, every signature this
// page produces is rejected — so the strings are compared literally.
const CANISTER = "vizcg-th777-77774-qaaea-cai";
/** base58 of [0xCC; 32]. */
const TASK_B58 = "EnTJCS15dqbDTU2XywYSMaScoPv4Py4GzExrtY9DQxoD";
const TASK_ID = new Uint8Array(32).fill(0xcc);

const text = (message: Uint8Array): string => new TextDecoder().decode(message);

test("accept message matches the canister's vector", () => {
  assert.equal(
    text(taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "accept" })),
    "crown:conditional-tasks:v1\n" +
      "action: accept\n" +
      "chain: solana-devnet\n" +
      `canister: ${CANISTER}\n` +
      `task: ${TASK_B58}\n`,
  );
});

test("register message matches the canister's vector", () => {
  assert.equal(
    text(
      taskMessage("solana-devnet", CANISTER, TASK_ID, {
        kind: "register",
        textHash: new Uint8Array(2).fill(0x11),
        duration: 300n,
      }),
    ),
    "crown:conditional-tasks:v1\n" +
      "action: register\n" +
      "chain: solana-devnet\n" +
      `canister: ${CANISTER}\n` +
      `task: ${TASK_B58}\n` +
      "text: 1111\n" +
      "duration: 300\n",
  );
});

test("vote message matches the canister's vector", () => {
  for (const choice of [TASK_CHOICE.done, TASK_CHOICE.notDone]) {
    assert.equal(
      text(taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "vote", choice })),
      "crown:conditional-tasks:v1\n" +
        "action: vote\n" +
        "chain: solana-devnet\n" +
        `canister: ${CANISTER}\n` +
        `task: ${TASK_B58}\n` +
        `choice: ${choice}\n`,
    );
  }
});

test("channel message matches the canister's vector", () => {
  assert.equal(
    text(channelMessage("solana-devnet", CANISTER, new Uint8Array(32).fill(0x02), 34n, 5n, true, 7n)),
    "crown:conditional-tasks:v1\n" +
      "action: set-channel-params\n" +
      "chain: solana-devnet\n" +
      `canister: ${CANISTER}\n` +
      "streamer: 8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR\n" +
      "min_gross: 34\n" +
      "min_reputation: 5\n" +
      "enabled: true\n" +
      "counter: 7\n",
  );
});

test("task action and choice words are pinned", () => {
  assert.deepEqual(TASK_CHOICE, { done: "done", notDone: "not_done" });
  assert.deepEqual(FUNDING_ACTION, { create: 0, released: 1, vote: 2 });
  assert.deepEqual(FUNDING_CHOICE, { released: 0, notReleased: 1 });
});

/**
 * The requirement a wallet actually enforces, and the whole reason these
 * messages are text. Phantom's `isSafeMessage` — read out of the installed
 * extension (26.21.1): `isValidUTF8(bytes)` first, then a check that the bytes
 * do not deserialize into a transaction carrying instructions — rejects
 * anything else with "You cannot sign solana transactions using sign message".
 * The old binary format failed the UTF-8 half, so the game was unplayable with
 * the largest Solana wallet.
 *
 * This pins the requirement, not their code.
 */
test("every Tasks message a wallet must sign is UTF-8 and not a transaction", () => {
  const messages = [
    taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "accept" }),
    taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "decline" }),
    taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "done" }),
    taskMessage("solana-devnet", CANISTER, TASK_ID, { kind: "vote", choice: TASK_CHOICE.done }),
    taskMessage("solana-devnet", CANISTER, TASK_ID, {
      kind: "register",
      textHash: new Uint8Array(32).fill(0xff),
      duration: 18_446_744_073_709_551_615n,
    }),
    channelMessage("solana-devnet", CANISTER, new Uint8Array(32).fill(0xff), 34n, 5n, false, 7n),
  ];
  for (const message of messages) {
    // Strict decoding throws on any byte that is not valid UTF-8.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(message);
    // The text is exactly the bytes signed — nothing lossy in between.
    assert.equal(hex(utf8(decoded)), hex(message));
    // And it must stay unreadable as a transaction.
    assert.throws(() => Message.from(Buffer.from(message)));
    assert.throws(() => VersionedMessage.deserialize(message));
  }
});

// Mirror of collection_message_layout_is_pinned (Conditional-Funding auth.rs).
test("collection message layout is pinned", () => {
  const message = collectionMessage(
    "solana-devnet",
    new Uint8Array([0xaa]),
    new Uint8Array([0xbb]),
    FUNDING_ACTION.vote,
    new Uint8Array([FUNDING_CHOICE.released]),
  );
  const expected = concat(
    utf8("crown:conditional-funding:v1"),
    u32le(13),
    utf8("solana-devnet"),
    u32le(1),
    new Uint8Array([0xaa]),
    u32le(1),
    new Uint8Array([0xbb]),
    u8(2),
    u32le(1),
    new Uint8Array([0x00]),
  );
  assert.equal(hex(message), hex(expected));
});

test("create payload layout is pinned", () => {
  assert.equal(hex(createPayload(1_000_000n, 1800n)), hex(concat(u64le(1_000_000n), u64le(1800n))));
});

/**
 * Cross-tool vector from the Funding canister's tests, computed independently
 * with python hashlib:
 *   sha256(b"crown:conditional-funding" + bytes([10]) + bytes([0x01]*10)
 *          + bytes([0x22]*32) + struct.pack("<Q", 7))
 */
test("collection id matches the cross-tool vector", () => {
  const id = collectionId(new Uint8Array(10).fill(0x01), new Uint8Array(32).fill(0x22), 7n);
  assert.equal(hex(id), "8290545b8688a98c920c2e4c4979b69a0923c956d205c901a9dd57d94a91cadd");
});

// The principal is length-prefixed precisely so principals of different
// lengths cannot collide into one id.
test("collection id is injective in the principal length", () => {
  const km = new Uint8Array(32).fill(0x22);
  const short = collectionId(new Uint8Array([0x01]), km, 1n);
  const long = collectionId(new Uint8Array([0x01, 0x00]), km, 1n);
  assert.notEqual(hex(short), hex(long));
});

// Mirror of the Subscription canister's cancel_authorization unit test.
test("cancel authorization layout is pinned", () => {
  const message = cancelAuthorization(
    "solana-devnet",
    new Uint8Array([0xaa, 0xbb]),
    new Uint8Array(3).fill(0xcc),
  );
  const expected = concat(
    utf8("crown:subscription:v1"),
    lp(utf8("solana-devnet")),
    lp(new Uint8Array([0xaa, 0xbb])),
    lp(new Uint8Array(3).fill(0xcc)),
    u8(0),
  );
  assert.equal(hex(message), hex(expected));
});

// ---- verdict messages (verified by the on-chain programs) ----------------

const FACTORY = new PublicKey("83f7ziVs5VeQ8xiDka8zczbfJT4WcxsXQ18cqWwmV5ur");
const STREAM_FACTORY = new PublicKey("57MpCQ3TfAE66qDAnfkP9AX7LRqwd4CNX8uN6DaVwm3V");
const ESCROW = new PublicKey("CszaaibvYybHEURAWc297DGg7wCF5NXQ7196dAQJsw7y");

// Lengths are the factory's measured constants (docs/factory-spec.md §5):
// two-outcome claim 96, stream release 93, stream cancel 91.
test("verdict messages are pinned in layout and length", () => {
  const claim = twoOutcomeVerdictMessage("crown:two-outcome:solana-devnet", FACTORY, ESCROW, 1);
  assert.equal(
    hex(claim),
    hex(concat(utf8("crown:two-outcome:solana-devnet"), FACTORY.toBytes(), ESCROW.toBytes(), u8(1))),
  );
  assert.equal(claim.length, 96);

  const release = releaseMessage("crown:stream:solana-devnet", STREAM_FACTORY, ESCROW, 258);
  assert.equal(
    hex(release),
    hex(
      concat(
        utf8("crown:stream:solana-devnet"),
        STREAM_FACTORY.toBytes(),
        ESCROW.toBytes(),
        u8(0x00),
        u16le(258),
      ),
    ),
  );
  assert.equal(release.length, 93);
  // The index is little-endian: 258 = [0x02, 0x01], never [0x01, 0x02].
  assert.deepEqual(Array.from(release.slice(-2)), [0x02, 0x01]);

  const cancel = cancelMessage("crown:stream:solana-devnet", STREAM_FACTORY, ESCROW);
  assert.equal(cancel.length, 91);
  assert.equal(cancel[cancel.length - 1], 0x01);
});

// A release message and a cancel message of the same escrow must never
// coincide: one signature may open exactly one door.
test("release and cancel messages are distinct", () => {
  const release = releaseMessage("crown:stream:solana-devnet", STREAM_FACTORY, ESCROW, 0);
  const cancel = cancelMessage("crown:stream:solana-devnet", STREAM_FACTORY, ESCROW);
  assert.notEqual(hex(release), hex(cancel));
});
