// Candid surfaces of the five canisters the lab talks to. The IDLs mirror the
// .did files of crown-index and the four games; nothing here is invented.
//
// The games answer `get_task`/`get_collection`/`get_auction` with the exact
// stored candid bytes plus a certificate — so the record type is declared once
// and used both as the query's return type and as the decoder of those bytes.

import { Actor, type ActorSubclass, type Agent, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";

const Blob = IDL.Vec(IDL.Nat8);
const result = (ok: IDL.Type) => IDL.Variant({ Ok: ok, Err: IDL.Text });
const unitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });

export type CandidResult<T> = { Ok: T } | { Err: string };
/** Candid `opt T` arrives as [] | [T]. */
export type Opt<T> = [] | [T];

export function optional<T>(value: Opt<T>): T | null {
  return value.length === 1 ? value[0] : null;
}

/** Candid blobs arrive as Uint8Array or number[] depending on the agent path. */
export function asBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export async function agentFor(host: string): Promise<Agent> {
  return HttpAgent.create({
    host,
    // A local replica signs with its own key; the page must fetch it.
    shouldFetchRootKey: host.includes("127.0.0.1") || host.includes("localhost"),
  });
}

// ---- crown-index ----------------------------------------------------------

// This is the business Crown-Index: the book is filled by paid pushes through
// crown-relay, not by polling. So there is no alarm clock and no cursor — the
// exactly-once state is the applied-signature set (index-spec §7).
const crownIndexIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_reputation: IDL.Func([IDL.Text, Blob, Blob], [IDL.Nat], ["query"]),
    get_applied_count: IDL.Func([], [IDL.Nat64], ["query"]),
    get_reduce_version: IDL.Func([], [IDL.Nat32], ["query"]),
    get_anomaly_count: IDL.Func([], [IDL.Nat64], ["query"]),
  });

export interface CrownIndexActor {
  /** book[(chain, donor, recipient)] — minor units of USDC that reached the recipient. */
  get_reputation(chain: string, donor: Uint8Array, recipient: Uint8Array): Promise<bigint>;
  /** Signatures included in the book so far (replaces the old cursor). */
  get_applied_count(): Promise<bigint>;
  get_reduce_version(): Promise<number>;
  /** Transactions the cross-check refused. Anything but 0 is a bug worth reading. */
  get_anomaly_count(): Promise<bigint>;
}

export function crownIndexActor(agent: Agent, canisterId: string): CrownIndexActor {
  return Actor.createActor(crownIndexIdl, { agent, canisterId }) as ActorSubclass<CrownIndexActor>;
}

// ---- crown-relay ----------------------------------------------------------
// The platform's paid pusher: submit(signature) forwards to crown-index's
// ingest_settlement with cycles. An ordinary call — the caller attaches nothing.

const IngestResult = IDL.Variant({ Applied: IDL.Nat32, Rejected: IDL.Text });
const SubmitResult = IDL.Variant({ Forwarded: IngestResult, Refused: IDL.Text });

const crownRelayIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    submit: IDL.Func([IDL.Text], [SubmitResult], []),
    get_index: IDL.Func([], [IDL.Opt(IDL.Principal)], ["query"]),
  });

export type SubmitResultTS =
  | { Forwarded: { Applied: number } | { Rejected: string } }
  | { Refused: string };

export interface CrownRelayActor {
  /** Pay to include one settlement by signature; the relayer attaches the cycles. */
  submit(signature: string): Promise<SubmitResultTS>;
  get_index(): Promise<Opt<Principal>>;
}

export function crownRelayActor(agent: Agent, canisterId: string): CrownRelayActor {
  return Actor.createActor(crownRelayIdl, { agent, canisterId }) as ActorSubclass<CrownRelayActor>;
}

// ---- conditional-tasks ----------------------------------------------------

const TaskOutcome = IDL.Variant({ settle: IDL.Null, cancel: IDL.Null });
const TaskState = IDL.Variant({
  created: IDL.Null,
  accepted: IDL.Null,
  voting: IDL.Record({ started_at: IDL.Nat64 }),
  decided: IDL.Record({ outcome: TaskOutcome }),
});
const TaskChoice = IDL.Variant({ done: IDL.Null, not_done: IDL.Null });
const TaskVote = IDL.Record({ voter: Blob, choice: TaskChoice, weight: IDL.Nat });
/** The stored record: `data` of get_task is exactly its candid bytes. */
const TaskRecord = IDL.Record({
  chain: IDL.Text,
  task_id: Blob,
  donor: Blob,
  recipient: Blob,
  gross: IDL.Nat64,
  deadline: IDL.Nat64,
  resolver: Blob,
  nonce: IDL.Nat64,
  text_hash: Blob,
  registered_at: IDL.Nat64,
  duration: IDL.Nat64,
  voting_period: IDL.Nat64,
  state: TaskState,
  votes: IDL.Vec(TaskVote),
  verdict_signature: IDL.Opt(Blob),
  operator_refunded_at: IDL.Opt(IDL.Nat64),
});
const CertifiedTask = IDL.Record({ data: Blob, certificate: IDL.Opt(Blob), witness: Blob });
const Profile = IDL.Record({
  min_gross: IDL.Nat64,
  min_reputation: IDL.Nat,
  enabled: IDL.Bool,
  counter: IDL.Nat64,
});
const Verdict = IDL.Record({ outcome: TaskOutcome, signature: IDL.Opt(Blob) });

const tasksIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    register_task: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          donor: Blob,
          recipient: Blob,
          gross: IDL.Nat64,
          deadline: IDL.Nat64,
          resolver: Blob,
          nonce: IDL.Nat64,
          duration: IDL.Nat64,
          text_hash: Blob,
          signature: Blob,
        }),
      ],
      [result(Blob)],
      [],
    ),
    accept: IDL.Func([IDL.Record({ chain: IDL.Text, task_id: Blob, signature: Blob })], [unitResult], []),
    decline: IDL.Func([IDL.Record({ chain: IDL.Text, task_id: Blob, signature: Blob })], [unitResult], []),
    ready: IDL.Func([IDL.Record({ chain: IDL.Text, task_id: Blob, signature: Blob })], [unitResult], []),
    operator_refund: IDL.Func(
      [IDL.Record({ chain: IDL.Text, task_id: Blob, signature: Blob })],
      [unitResult],
      [],
    ),
    vote: IDL.Func(
      [IDL.Record({ chain: IDL.Text, task_id: Blob, voter: Blob, choice: TaskChoice, signature: Blob })],
      [unitResult],
      [],
    ),
    set_profile: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          recipient: Blob,
          min_gross: IDL.Nat64,
          min_reputation: IDL.Nat,
          enabled: IDL.Bool,
          counter: IDL.Nat64,
          signature: Blob,
        }),
      ],
      [unitResult],
      [],
    ),
    get_task: IDL.Func([IDL.Text, Blob], [IDL.Opt(CertifiedTask)], ["query"]),
    list_tasks: IDL.Func([IDL.Text, Blob], [IDL.Vec(Blob)], ["query"]),
    get_profile: IDL.Func([IDL.Text, Blob], [IDL.Opt(Profile)], ["query"]),
    get_resolver: IDL.Func([IDL.Text], [IDL.Opt(Blob)], ["query"]),
    get_verdict: IDL.Func([IDL.Text, Blob], [IDL.Opt(Verdict)], ["query"]),
    get_logic_version: IDL.Func([], [IDL.Nat32], ["query"]),
  });

export type TaskOutcomeView = { settle: null } | { cancel: null };
export type TaskChoiceView = { done: null } | { not_done: null };
export type TaskStateView =
  | { created: null }
  | { accepted: null }
  | { voting: { started_at: bigint } }
  | { decided: { outcome: TaskOutcomeView } };

export interface TaskRecordView {
  chain: string;
  task_id: Uint8Array | number[];
  donor: Uint8Array | number[];
  recipient: Uint8Array | number[];
  gross: bigint;
  deadline: bigint;
  resolver: Uint8Array | number[];
  nonce: bigint;
  text_hash: Uint8Array | number[];
  registered_at: bigint;
  duration: bigint;
  voting_period: bigint;
  state: TaskStateView;
  votes: { voter: Uint8Array | number[]; choice: TaskChoiceView; weight: bigint }[];
  verdict_signature: Opt<Uint8Array | number[]>;
  operator_refunded_at: Opt<bigint>;
}

export interface TasksActor {
  register_task(arg: {
    chain: string;
    donor: Uint8Array;
    recipient: Uint8Array;
    gross: bigint;
    deadline: bigint;
    resolver: Uint8Array;
    nonce: bigint;
    duration: bigint;
    text_hash: Uint8Array;
    signature: Uint8Array;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  accept(arg: { chain: string; task_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
  decline(arg: { chain: string; task_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
  ready(arg: { chain: string; task_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
  operator_refund(arg: {
    chain: string;
    task_id: Uint8Array;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  vote(arg: {
    chain: string;
    task_id: Uint8Array;
    voter: Uint8Array;
    choice: TaskChoiceView;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  set_profile(arg: {
    chain: string;
    recipient: Uint8Array;
    min_gross: bigint;
    min_reputation: bigint;
    enabled: boolean;
    counter: bigint;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  get_task(
    chain: string,
    taskId: Uint8Array,
  ): Promise<Opt<{ data: Uint8Array | number[]; certificate: Opt<Uint8Array | number[]>; witness: Uint8Array | number[] }>>;
  list_tasks(chain: string, recipient: Uint8Array): Promise<(Uint8Array | number[])[]>;
  get_profile(
    chain: string,
    recipient: Uint8Array,
  ): Promise<Opt<{ min_gross: bigint; min_reputation: bigint; enabled: boolean; counter: bigint }>>;
  get_resolver(chain: string): Promise<Opt<Uint8Array | number[]>>;
  get_verdict(
    chain: string,
    taskId: Uint8Array,
  ): Promise<Opt<{ outcome: TaskOutcomeView; signature: Opt<Uint8Array | number[]> }>>;
  get_logic_version(): Promise<number>;
}

export function tasksActor(agent: Agent, canisterId: string): TasksActor {
  return Actor.createActor(tasksIdl, { agent, canisterId }) as ActorSubclass<TasksActor>;
}

/** Decodes the certified bytes of get_task into the record they encode. */
export function decodeTaskRecord(data: Uint8Array): TaskRecordView {
  return IDL.decode([TaskRecord], data)[0] as unknown as TaskRecordView;
}

// ---- conditional-funding --------------------------------------------------

const FundingOutcome = IDL.Variant({ settle: IDL.Null, refund: IDL.Null });
const FundingState = IDL.Variant({
  funding: IDL.Null,
  voting: IDL.Record({ started_at: IDL.Nat64 }),
  decided: IDL.Record({ outcome: FundingOutcome }),
});
const FundingChoice = IDL.Variant({ done: IDL.Null, not_done: IDL.Null });
const FundingVote = IDL.Record({ voter: Blob, choice: FundingChoice, weight: IDL.Nat });
const CollectionRecord = IDL.Record({
  chain: IDL.Text,
  collection_id: Blob,
  recipient: Blob,
  recipient_nonce: IDL.Nat64,
  goal: IDL.Nat64,
  resolver: Blob,
  created_at: IDL.Nat64,
  duration: IDL.Nat64,
  voting_period: IDL.Nat64,
  approval_threshold: IDL.Nat16,
  quorum_weight: IDL.Nat,
  state: FundingState,
  votes: IDL.Vec(FundingVote),
  operator_refunded_at: IDL.Opt(IDL.Nat64),
});
const CertifiedCollection = IDL.Record({ data: Blob, certificate: IDL.Opt(Blob), witness: Blob });
const SignedVerdict = IDL.Record({ escrow: Blob, outcome: FundingOutcome, signature: Blob });

const fundingIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    create_collection: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          recipient: Blob,
          recipient_nonce: IDL.Nat64,
          goal: IDL.Nat64,
          duration: IDL.Nat64,
          signature: Blob,
        }),
      ],
      [result(Blob)],
      [],
    ),
    ready: IDL.Func([IDL.Record({ chain: IDL.Text, collection_id: Blob, signature: Blob })], [unitResult], []),
    recipient_cancel: IDL.Func(
      [IDL.Record({ chain: IDL.Text, collection_id: Blob, signature: Blob })],
      [unitResult],
      [],
    ),
    operator_refund: IDL.Func(
      [IDL.Record({ chain: IDL.Text, collection_id: Blob, signature: Blob })],
      [unitResult],
      [],
    ),
    vote: IDL.Func(
      [IDL.Record({ chain: IDL.Text, collection_id: Blob, voter: Blob, choice: FundingChoice, signature: Blob })],
      [unitResult],
      [],
    ),
    request_signature: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          collection_id: Blob,
          donor: Blob,
          gross: IDL.Nat64,
          deadline: IDL.Nat64,
          nonce: IDL.Nat64,
        }),
      ],
      [result(SignedVerdict)],
      [],
    ),
    get_collection: IDL.Func([IDL.Text, Blob], [IDL.Opt(CertifiedCollection)], ["query"]),
    get_resolver: IDL.Func([IDL.Text, Blob], [IDL.Opt(Blob)], ["query"]),
    list_collections: IDL.Func([IDL.Text, Blob], [IDL.Vec(Blob)], ["query"]),
    get_logic_version: IDL.Func([], [IDL.Nat32], ["query"]),
  });

export type FundingOutcomeView = { settle: null } | { refund: null };
export type FundingChoiceView = { done: null } | { not_done: null };
export type FundingStateView =
  | { funding: null }
  | { voting: { started_at: bigint } }
  | { decided: { outcome: FundingOutcomeView } };

export interface CollectionRecordView {
  chain: string;
  collection_id: Uint8Array | number[];
  recipient: Uint8Array | number[];
  recipient_nonce: bigint;
  goal: bigint;
  resolver: Uint8Array | number[];
  created_at: bigint;
  duration: bigint;
  voting_period: bigint;
  approval_threshold: number;
  quorum_weight: bigint;
  state: FundingStateView;
  votes: { voter: Uint8Array | number[]; choice: FundingChoiceView; weight: bigint }[];
  operator_refunded_at: Opt<bigint>;
}

export interface FundingActor {
  create_collection(arg: {
    chain: string;
    recipient: Uint8Array;
    recipient_nonce: bigint;
    goal: bigint;
    duration: bigint;
    signature: Uint8Array;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  ready(arg: { chain: string; collection_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
  recipient_cancel(arg: {
    chain: string;
    collection_id: Uint8Array;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  operator_refund(arg: {
    chain: string;
    collection_id: Uint8Array;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  vote(arg: {
    chain: string;
    collection_id: Uint8Array;
    voter: Uint8Array;
    choice: FundingChoiceView;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  request_signature(arg: {
    chain: string;
    collection_id: Uint8Array;
    donor: Uint8Array;
    gross: bigint;
    deadline: bigint;
    nonce: bigint;
  }): Promise<
    CandidResult<{
      escrow: Uint8Array | number[];
      outcome: FundingOutcomeView;
      signature: Uint8Array | number[];
    }>
  >;
  get_collection(
    chain: string,
    collectionId: Uint8Array,
  ): Promise<Opt<{ data: Uint8Array | number[]; certificate: Opt<Uint8Array | number[]>; witness: Uint8Array | number[] }>>;
  get_resolver(chain: string, collectionId: Uint8Array): Promise<Opt<Uint8Array | number[]>>;
  list_collections(chain: string, recipient: Uint8Array): Promise<(Uint8Array | number[])[]>;
  get_logic_version(): Promise<number>;
}

export function fundingActor(agent: Agent, canisterId: string): FundingActor {
  return Actor.createActor(fundingIdl, { agent, canisterId }) as ActorSubclass<FundingActor>;
}

export function decodeCollectionRecord(data: Uint8Array): CollectionRecordView {
  return IDL.decode([CollectionRecord], data)[0] as unknown as CollectionRecordView;
}

// ---- auction --------------------------------------------------------------

const AuctionOutcome = IDL.Variant({ settle: IDL.Null, cancel: IDL.Null });
const AuctionState = IDL.Variant({
  bidding: IDL.Null,
  finale_due: IDL.Null,
  performing: IDL.Null,
  voting: IDL.Record({ started_at: IDL.Nat64 }),
  done: IDL.Record({ winner: IDL.Opt(AuctionOutcome) }),
});
const AuctionChoice = IDL.Variant({ done: IDL.Null, not_done: IDL.Null });
const AuctionVote = IDL.Record({ voter: Blob, choice: AuctionChoice, weight: IDL.Nat });
const ReturnActor = IDL.Variant({ recipient: IDL.Null, operator: IDL.Null });
const ReturnStamp = IDL.Record({ at: IDL.Nat64, by: ReturnActor });
/** The stored record: `data` of get_auction is exactly its candid bytes. */
const AuctionRecord = IDL.Record({
  chain: IDL.Text,
  auction_id: Blob,
  recipient: Blob,
  recipient_nonce: IDL.Nat64,
  created_at: IDL.Nat64,
  duration: IDL.Nat64,
  perform_window: IDL.Nat64,
  voting_period: IDL.Nat64,
  min_entry: IDL.Nat64,
  state: AuctionState,
  votes: IDL.Vec(AuctionVote),
  winner_lot: IDL.Opt(Blob),
  operator_returned_at: IDL.Opt(IDL.Nat64),
});
const LotRecord = IDL.Record({
  lot_id: Blob,
  text_hash: Blob,
  resolver: Blob,
  accepted_at: IDL.Opt(IDL.Nat64),
  returned: IDL.Opt(ReturnStamp),
  sum: IDL.Nat,
  entries: IDL.Nat64,
});
const EntryRecord = IDL.Record({
  escrow: Blob,
  lot_id: Blob,
  donor: Blob,
  gross: IDL.Nat64,
  deadline: IDL.Nat64,
  nonce: IDL.Nat64,
  seq: IDL.Nat64,
  returned: IDL.Opt(ReturnStamp),
});
const CertifiedAuction = IDL.Record({ data: Blob, certificate: IDL.Opt(Blob), witness: Blob });
const AuctionSignedVerdict = IDL.Record({ escrow: Blob, outcome: AuctionOutcome, signature: Blob });
const LotActionArg = IDL.Record({ chain: IDL.Text, auction_id: Blob, lot_id: Blob, signature: Blob });
const EntryActionArg = IDL.Record({ chain: IDL.Text, auction_id: Blob, escrow: Blob, signature: Blob });
const AuctionActionArg = IDL.Record({ chain: IDL.Text, auction_id: Blob, signature: Blob });

const auctionIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    create_auction: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          recipient: Blob,
          recipient_nonce: IDL.Nat64,
          duration: IDL.Nat64,
          perform_window: IDL.Nat64,
          min_entry: IDL.Nat64,
          signature: Blob,
        }),
      ],
      [result(Blob)],
      [],
    ),
    // An update, not a query: the lot's resolver is a threshold key derived
    // on demand at path [lot_id].
    get_resolver: IDL.Func([IDL.Record({ auction_id: Blob, text_hash: Blob })], [result(Blob)], []),
    register_entry: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          auction_id: Blob,
          text_hash: Blob,
          donor: Blob,
          gross: IDL.Nat64,
          deadline: IDL.Nat64,
          nonce: IDL.Nat64,
        }),
      ],
      [result(Blob)],
      [],
    ),
    accept_lot: IDL.Func([LotActionArg], [unitResult], []),
    return_lot: IDL.Func([LotActionArg], [unitResult], []),
    return_entry: IDL.Func([EntryActionArg], [unitResult], []),
    cancel_auction: IDL.Func([AuctionActionArg], [unitResult], []),
    ready: IDL.Func([AuctionActionArg], [unitResult], []),
    vote: IDL.Func(
      [IDL.Record({ chain: IDL.Text, auction_id: Blob, voter: Blob, choice: AuctionChoice, signature: Blob })],
      [unitResult],
      [],
    ),
    operator_refund_lot: IDL.Func([LotActionArg], [unitResult], []),
    operator_refund_entry: IDL.Func([EntryActionArg], [unitResult], []),
    operator_cancel_auction: IDL.Func([AuctionActionArg], [unitResult], []),
    request_signature: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          auction_id: Blob,
          text_hash: Blob,
          donor: Blob,
          gross: IDL.Nat64,
          deadline: IDL.Nat64,
          nonce: IDL.Nat64,
        }),
      ],
      [result(AuctionSignedVerdict)],
      [],
    ),
    get_auction: IDL.Func([IDL.Text, Blob], [IDL.Opt(CertifiedAuction)], ["query"]),
    list_lots: IDL.Func([IDL.Text, Blob], [IDL.Vec(LotRecord)], ["query"]),
    list_entries: IDL.Func([IDL.Text, Blob, Blob], [IDL.Vec(EntryRecord)], ["query"]),
    get_logic_version: IDL.Func([], [IDL.Nat32], ["query"]),
  });

export type AuctionOutcomeView = { settle: null } | { cancel: null };
export type AuctionChoiceView = { done: null } | { not_done: null };
export type ReturnStampView = { at: bigint; by: { recipient: null } | { operator: null } };
export type AuctionStateView =
  | { bidding: null }
  | { finale_due: null }
  | { performing: null }
  | { voting: { started_at: bigint } }
  | { done: { winner: Opt<AuctionOutcomeView> } };

export interface AuctionRecordView {
  chain: string;
  auction_id: Uint8Array | number[];
  recipient: Uint8Array | number[];
  recipient_nonce: bigint;
  created_at: bigint;
  duration: bigint;
  perform_window: bigint;
  voting_period: bigint;
  min_entry: bigint;
  state: AuctionStateView;
  votes: { voter: Uint8Array | number[]; choice: AuctionChoiceView; weight: bigint }[];
  winner_lot: Opt<Uint8Array | number[]>;
  operator_returned_at: Opt<bigint>;
}

export interface LotView {
  lot_id: Uint8Array | number[];
  text_hash: Uint8Array | number[];
  resolver: Uint8Array | number[];
  accepted_at: Opt<bigint>;
  returned: Opt<ReturnStampView>;
  sum: bigint;
  entries: bigint;
}

export interface EntryView {
  escrow: Uint8Array | number[];
  lot_id: Uint8Array | number[];
  donor: Uint8Array | number[];
  gross: bigint;
  deadline: bigint;
  nonce: bigint;
  seq: bigint;
  returned: Opt<ReturnStampView>;
}

interface LotActionArgView {
  chain: string;
  auction_id: Uint8Array;
  lot_id: Uint8Array;
  signature: Uint8Array;
}
interface EntryActionArgView {
  chain: string;
  auction_id: Uint8Array;
  escrow: Uint8Array;
  signature: Uint8Array;
}
interface AuctionActionArgView {
  chain: string;
  auction_id: Uint8Array;
  signature: Uint8Array;
}

export interface AuctionActor {
  create_auction(arg: {
    chain: string;
    recipient: Uint8Array;
    recipient_nonce: bigint;
    duration: bigint;
    perform_window: bigint;
    min_entry: bigint;
    signature: Uint8Array;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  get_resolver(arg: {
    auction_id: Uint8Array;
    text_hash: Uint8Array;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  register_entry(arg: {
    chain: string;
    auction_id: Uint8Array;
    text_hash: Uint8Array;
    donor: Uint8Array;
    gross: bigint;
    deadline: bigint;
    nonce: bigint;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  accept_lot(arg: LotActionArgView): Promise<CandidResult<null>>;
  return_lot(arg: LotActionArgView): Promise<CandidResult<null>>;
  return_entry(arg: EntryActionArgView): Promise<CandidResult<null>>;
  cancel_auction(arg: AuctionActionArgView): Promise<CandidResult<null>>;
  ready(arg: AuctionActionArgView): Promise<CandidResult<null>>;
  vote(arg: {
    chain: string;
    auction_id: Uint8Array;
    voter: Uint8Array;
    choice: AuctionChoiceView;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  operator_refund_lot(arg: LotActionArgView): Promise<CandidResult<null>>;
  operator_refund_entry(arg: EntryActionArgView): Promise<CandidResult<null>>;
  operator_cancel_auction(arg: AuctionActionArgView): Promise<CandidResult<null>>;
  request_signature(arg: {
    chain: string;
    auction_id: Uint8Array;
    text_hash: Uint8Array;
    donor: Uint8Array;
    gross: bigint;
    deadline: bigint;
    nonce: bigint;
  }): Promise<
    CandidResult<{
      escrow: Uint8Array | number[];
      outcome: AuctionOutcomeView;
      signature: Uint8Array | number[];
    }>
  >;
  get_auction(
    chain: string,
    auctionId: Uint8Array,
  ): Promise<Opt<{ data: Uint8Array | number[]; certificate: Opt<Uint8Array | number[]>; witness: Uint8Array | number[] }>>;
  list_lots(chain: string, auctionId: Uint8Array): Promise<LotView[]>;
  list_entries(chain: string, auctionId: Uint8Array, lotId: Uint8Array): Promise<EntryView[]>;
  get_logic_version(): Promise<number>;
}

export function auctionActor(agent: Agent, canisterId: string): AuctionActor {
  return Actor.createActor(auctionIdl, { agent, canisterId }) as ActorSubclass<AuctionActor>;
}

/** Decodes the certified bytes of get_auction into the record they encode. */
export function decodeAuctionRecord(data: Uint8Array): AuctionRecordView {
  return IDL.decode([AuctionRecord], data)[0] as unknown as AuctionRecordView;
}

// ---- subscription ---------------------------------------------------------

const StreamBirthFields = {
  chain: IDL.Text,
  subscription_id: Blob,
  donor: Blob,
  recipients: IDL.Vec(Blob),
  shares: IDL.Vec(IDL.Nat16),
  chunk: IDL.Nat64,
  n_chunks: IDL.Nat16,
  t0: IDL.Int64,
  period: IDL.Int64,
  nonce: IDL.Nat64,
};
const ReleaseArg = IDL.Record({ ...StreamBirthFields, index: IDL.Nat16 });
const CancelArg = IDL.Record({ ...StreamBirthFields, signature: Blob });
const SignedRelease = IDL.Record({ escrow: Blob, index: IDL.Nat16, signature: Blob });
const SignedCancel = IDL.Record({ escrow: Blob, signature: Blob });

const subscriptionIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    // An update, not a query: deriving the threshold key is an async call and
    // this canister stores nothing at all.
    get_resolver: IDL.Func([IDL.Text, Blob], [result(Blob)], []),
    request_release: IDL.Func([ReleaseArg], [result(SignedRelease)], []),
    request_cancel: IDL.Func([CancelArg], [result(SignedCancel)], []),
    get_logic_version: IDL.Func([], [IDL.Nat32], ["query"]),
  });

export interface SubscriptionBirthArg {
  chain: string;
  subscription_id: Uint8Array;
  donor: Uint8Array;
  recipients: Uint8Array[];
  shares: number[];
  chunk: bigint;
  n_chunks: number;
  t0: bigint;
  period: bigint;
  nonce: bigint;
}

export interface SubscriptionActor {
  get_resolver(chain: string, subscriptionId: Uint8Array): Promise<CandidResult<Uint8Array | number[]>>;
  request_release(
    arg: SubscriptionBirthArg & { index: number },
  ): Promise<CandidResult<{ escrow: Uint8Array | number[]; index: number; signature: Uint8Array | number[] }>>;
  request_cancel(
    arg: SubscriptionBirthArg & { signature: Uint8Array },
  ): Promise<CandidResult<{ escrow: Uint8Array | number[]; signature: Uint8Array | number[] }>>;
  get_logic_version(): Promise<number>;
}

export function subscriptionActor(agent: Agent, canisterId: string): SubscriptionActor {
  return Actor.createActor(subscriptionIdl, { agent, canisterId }) as ActorSubclass<SubscriptionActor>;
}
