// Candid surfaces of the four canisters the lab talks to. The IDLs mirror the
// .did files of crown-index and the three games; nothing here is invented.
//
// Two of the games answer `get_task`/`get_collection` with the exact stored
// candid bytes plus a certificate — so the record type is declared once and
// used both as the query's return type and as the decoder of those bytes.

import { Actor, type ActorSubclass, type Agent, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";

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

const crownIndexIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_reputation: IDL.Func([IDL.Text, Blob, Blob], [IDL.Nat], ["query"]),
    get_cursor: IDL.Func([IDL.Text], [IDL.Opt(IDL.Text)], ["query"]),
    get_reduce_version: IDL.Func([], [IDL.Nat32], ["query"]),
    get_anomaly_count: IDL.Func([], [IDL.Nat64], ["query"]),
  });

export interface CrownIndexActor {
  /** book[(chain, payer, streamer)] — minor units of USDC that reached the streamer. */
  get_reputation(chain: string, payer: Uint8Array, streamer: Uint8Array): Promise<bigint>;
  get_cursor(chain: string): Promise<Opt<string>>;
  get_reduce_version(): Promise<number>;
  /** Transactions the cross-check refused. Anything but 0 is a bug worth reading. */
  get_anomaly_count(): Promise<bigint>;
}

export function crownIndexActor(agent: Agent, canisterId: string): CrownIndexActor {
  return Actor.createActor(crownIndexIdl, { agent, canisterId }) as ActorSubclass<CrownIndexActor>;
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
  streamer: Blob,
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
});
const CertifiedTask = IDL.Record({ data: Blob, certificate: IDL.Opt(Blob), witness: Blob });
const Channel = IDL.Record({
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
          streamer: Blob,
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
    done: IDL.Func([IDL.Record({ chain: IDL.Text, task_id: Blob, signature: Blob })], [unitResult], []),
    vote: IDL.Func(
      [IDL.Record({ chain: IDL.Text, task_id: Blob, voter: Blob, choice: TaskChoice, signature: Blob })],
      [unitResult],
      [],
    ),
    set_channel_params: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          streamer: Blob,
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
    get_channel: IDL.Func([IDL.Text, Blob], [IDL.Opt(Channel)], ["query"]),
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
  streamer: Uint8Array | number[];
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
}

export interface TasksActor {
  register_task(arg: {
    chain: string;
    donor: Uint8Array;
    streamer: Uint8Array;
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
  done(arg: { chain: string; task_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
  vote(arg: {
    chain: string;
    task_id: Uint8Array;
    voter: Uint8Array;
    choice: TaskChoiceView;
    signature: Uint8Array;
  }): Promise<CandidResult<null>>;
  set_channel_params(arg: {
    chain: string;
    streamer: Uint8Array;
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
  list_tasks(chain: string, streamer: Uint8Array): Promise<(Uint8Array | number[])[]>;
  get_channel(
    chain: string,
    streamer: Uint8Array,
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
const FundingChoice = IDL.Variant({ released: IDL.Null, not_released: IDL.Null });
const FundingVote = IDL.Record({ voter: Blob, choice: FundingChoice, weight: IDL.Nat });
const CollectionRecord = IDL.Record({
  chain: IDL.Text,
  collection_id: Blob,
  km: Blob,
  km_nonce: IDL.Nat64,
  goal: IDL.Nat64,
  resolver: Blob,
  created_at: IDL.Nat64,
  duration: IDL.Nat64,
  voting_period: IDL.Nat64,
  approval_threshold: IDL.Nat16,
  quorum_weight: IDL.Nat,
  state: FundingState,
  votes: IDL.Vec(FundingVote),
});
const CertifiedCollection = IDL.Record({ data: Blob, certificate: IDL.Opt(Blob), witness: Blob });
const SignedVerdict = IDL.Record({ escrow: Blob, outcome: FundingOutcome, signature: Blob });

const fundingIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    create_collection: IDL.Func(
      [
        IDL.Record({
          chain: IDL.Text,
          km: Blob,
          km_nonce: IDL.Nat64,
          goal: IDL.Nat64,
          duration: IDL.Nat64,
          signature: Blob,
        }),
      ],
      [result(Blob)],
      [],
    ),
    released: IDL.Func([IDL.Record({ chain: IDL.Text, collection_id: Blob, signature: Blob })], [unitResult], []),
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
export type FundingChoiceView = { released: null } | { not_released: null };
export type FundingStateView =
  | { funding: null }
  | { voting: { started_at: bigint } }
  | { decided: { outcome: FundingOutcomeView } };

export interface CollectionRecordView {
  chain: string;
  collection_id: Uint8Array | number[];
  km: Uint8Array | number[];
  km_nonce: bigint;
  goal: bigint;
  resolver: Uint8Array | number[];
  created_at: bigint;
  duration: bigint;
  voting_period: bigint;
  approval_threshold: number;
  quorum_weight: bigint;
  state: FundingStateView;
  votes: { voter: Uint8Array | number[]; choice: FundingChoiceView; weight: bigint }[];
}

export interface FundingActor {
  create_collection(arg: {
    chain: string;
    km: Uint8Array;
    km_nonce: bigint;
    goal: bigint;
    duration: bigint;
    signature: Uint8Array;
  }): Promise<CandidResult<Uint8Array | number[]>>;
  released(arg: { chain: string; collection_id: Uint8Array; signature: Uint8Array }): Promise<CandidResult<null>>;
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
  list_collections(chain: string, km: Uint8Array): Promise<(Uint8Array | number[])[]>;
  get_logic_version(): Promise<number>;
}

export function fundingActor(agent: Agent, canisterId: string): FundingActor {
  return Actor.createActor(fundingIdl, { agent, canisterId }) as ActorSubclass<FundingActor>;
}

export function decodeCollectionRecord(data: Uint8Array): CollectionRecordView {
  return IDL.decode([CollectionRecord], data)[0] as unknown as CollectionRecordView;
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
