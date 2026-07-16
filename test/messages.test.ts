// Every message layout, pinned byte for byte against the canisters' own unit
// tests (each game's canister/src/auth.rs) and the shapes' verdict format.
// The expected bytes are spelled out here exactly as the Rust tests spell
// them: a layout that drifts is a signature no canister will accept.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Message, PublicKey, VersionedMessage } from "@solana/web3.js";

import { concat, hex, u8, u16le, utf8 } from "../src/bytes.ts";
import {
  TASK_CHOICE,
  FUNDING_CHOICE,
  cancelAuthorization,
  cancelMessage,
  channelMessage,
  collectionId,
  collectionMessage,
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

test("action and choice words are pinned", () => {
  assert.deepEqual(TASK_CHOICE, { done: "done", notDone: "not_done" });
  assert.deepEqual(FUNDING_CHOICE, { released: "released", notReleased: "not_released" });
});

/**
 * The requirement a wallet actually enforces, and the whole reason these
 * messages are text. Phantom's `isSafeMessage` — read out of the installed
 * extension (26.21.1): `isValidUTF8(bytes)` first, then a check that the bytes
 * do not deserialize into a transaction carrying instructions — rejects
 * anything else with "You cannot sign solana transactions using sign message" —
 * a binary format would make the game unplayable with the largest Solana
 * wallet.
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

// The Funding canister's own vectors (Conditional-Funding canister/src/auth.rs:
// released_message_is_pinned, create_message_is_pinned, vote_message_is_pinned).
const FUNDING_CANISTER = "vpyes-67777-77774-qaaeq-cai";
const COLLECTION = new Uint8Array(32).fill(0xcc);
const COLLECTION_HEX = "cc".repeat(32);

test("released message matches the canister's vector", () => {
  assert.equal(
    text(collectionMessage("solana-devnet", FUNDING_CANISTER, COLLECTION, { kind: "released" })),
    "crown:conditional-funding:v1\n" +
      "action: released\n" +
      "chain: solana-devnet\n" +
      `canister: ${FUNDING_CANISTER}\n` +
      `collection: ${COLLECTION_HEX}\n`,
  );
});

test("create message matches the canister's vector", () => {
  assert.equal(
    text(
      collectionMessage("solana-devnet", FUNDING_CANISTER, COLLECTION, {
        kind: "create",
        goal: 20_000_000_000n,
        duration: 86_400n,
      }),
    ),
    "crown:conditional-funding:v1\n" +
      "action: create\n" +
      "chain: solana-devnet\n" +
      `canister: ${FUNDING_CANISTER}\n` +
      `collection: ${COLLECTION_HEX}\n` +
      "goal: 20000000000\n" +
      "duration: 86400\n",
  );
});

test("funding vote message matches the canister's vector", () => {
  for (const choice of [FUNDING_CHOICE.released, FUNDING_CHOICE.notReleased]) {
    assert.equal(
      text(collectionMessage("solana-devnet", FUNDING_CANISTER, COLLECTION, { kind: "vote", choice })),
      "crown:conditional-funding:v1\n" +
        "action: vote\n" +
        "chain: solana-devnet\n" +
        `canister: ${FUNDING_CANISTER}\n` +
        `collection: ${COLLECTION_HEX}\n` +
        `choice: ${choice}\n`,
    );
  }
});

/**
 * Cross-tool vector from the Funding canister's tests, computed independently
 * with python hashlib. The id stays binary on purpose: it is the derivation
 * path of the collection's resolver, not a message anyone signs.
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

// Mirror of the Subscription canister's cancel_authorization_is_pinned test.
test("cancel authorization matches the canister's vector", () => {
  assert.equal(
    text(cancelAuthorization("solana-devnet", "vg3po-ix777-77774-qaafa-cai", new Uint8Array(32).fill(0xcc))),
    "crown:subscription:v1\n" +
      "action: cancel\n" +
      "chain: solana-devnet\n" +
      "canister: vg3po-ix777-77774-qaafa-cai\n" +
      `escrow: ${TASK_B58}\n`,
  );
});

// The same requirement as for Tasks, for every remaining wallet-signed message:
// Phantom signs valid UTF-8 and nothing else.
test("Funding and Subscription messages a wallet must sign are UTF-8", () => {
  const messages = [
    collectionMessage("solana-devnet", FUNDING_CANISTER, COLLECTION, { kind: "released" }),
    collectionMessage("solana-devnet", FUNDING_CANISTER, new Uint8Array(32).fill(0xff), {
      kind: "create",
      goal: 18_446_744_073_709_551_615n,
      duration: 18_446_744_073_709_551_615n,
    }),
    collectionMessage("solana-devnet", FUNDING_CANISTER, COLLECTION, {
      kind: "vote",
      choice: FUNDING_CHOICE.notReleased,
    }),
    cancelAuthorization("solana-devnet", "vg3po-ix777-77774-qaafa-cai", new Uint8Array(32).fill(0xff)),
  ];
  for (const message of messages) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(message);
    assert.equal(hex(utf8(decoded)), hex(message));
    assert.throws(() => Message.from(Buffer.from(message)));
    assert.throws(() => VersionedMessage.deserialize(message));
  }
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
