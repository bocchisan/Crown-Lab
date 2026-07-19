// What the page remembers between reloads: the escrows it created and the
// ids it derived. None of this is authority — the chain and the canisters are
// — but an escrow whose birth fields are lost is an escrow nobody can claim,
// cancel or even name, so the declarations are kept.
//
// Birth fields are stored as strings: they are u64/i64 values that JSON would
// silently round past 2^53.

export interface TaskEntry {
  escrow: string;
  taskId: string;
  donor: string;
  recipient: string;
  gross: string;
  deadline: string;
  duration: string;
  nonce: string;
  textHash: string;
}

export interface Contribution {
  escrow: string;
  donor: string;
  gross: string;
  deadline: string;
  nonce: string;
}

export interface CollectionEntry {
  collectionId: string;
  recipient: string;
  recipientNonce: string;
  goal: string;
  duration: string;
  resolver: string;
  contributions: Contribution[];
}

export interface LotEntry {
  lotId: string;
  /** The lot's condition in the clear; its sha256 is the canister's text_hash. */
  text: string;
  textHash: string;
  resolver: string;
  entries: Contribution[];
}

export interface AuctionEntry {
  auctionId: string;
  recipient: string;
  recipientNonce: string;
  duration: string;
  performWindow: string;
  minEntry: string;
  lots: LotEntry[];
}

export interface SubscriptionEntry {
  subscriptionId: string;
  escrow: string;
  donor: string;
  recipient: string;
  chunk: string;
  nChunks: number;
  t0: string;
  period: string;
  resolver: string;
}

interface Shape {
  tasks: TaskEntry[];
  collections: CollectionEntry[];
  auctions: AuctionEntry[];
  subscriptions: SubscriptionEntry[];
}

const KEY = "crown-lab:store";

const EMPTY: Shape = { tasks: [], collections: [], auctions: [], subscriptions: [] };

/**
 * Entries written before the big rename carry the old field names. The
 * declarations are the only key to those escrows, so they are migrated in
 * place instead of being dropped.
 */
function migrate(shape: Shape): Shape {
  for (const task of shape.tasks) {
    const legacy = task as TaskEntry & { streamer?: string };
    if (legacy.streamer && !task.recipient) task.recipient = legacy.streamer;
    delete legacy.streamer;
  }
  for (const collection of shape.collections) {
    const legacy = collection as CollectionEntry & { km?: string; kmNonce?: string };
    if (legacy.km && !collection.recipient) collection.recipient = legacy.km;
    if (legacy.kmNonce && !collection.recipientNonce) collection.recipientNonce = legacy.kmNonce;
    delete legacy.km;
    delete legacy.kmNonce;
  }
  return shape;
}

export function load(): Shape {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(EMPTY);
  try {
    return migrate({ ...structuredClone(EMPTY), ...(JSON.parse(raw) as Partial<Shape>) });
  } catch {
    return structuredClone(EMPTY);
  }
}

function save(shape: Shape): void {
  localStorage.setItem(KEY, JSON.stringify(shape));
}

export function update(mutate: (shape: Shape) => void): void {
  const shape = load();
  mutate(shape);
  save(shape);
}
