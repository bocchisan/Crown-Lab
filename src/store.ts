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
  streamer: string;
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
  km: string;
  kmNonce: string;
  goal: string;
  duration: string;
  resolver: string;
  contributions: Contribution[];
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
  subscriptions: SubscriptionEntry[];
}

const KEY = "crown-lab:store";

const EMPTY: Shape = { tasks: [], collections: [], subscriptions: [] };

export function load(): Shape {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(raw) as Partial<Shape>) };
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
