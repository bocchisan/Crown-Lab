// The lab's context: the chain profile baked at build time, the canister ids
// (baked by scripts/lab-up.sh, or pasted into the page and kept in
// localStorage), the actors, and the participants.
//
// Everything a panel needs is here; panels never read config themselves.

import { Connection, PublicKey } from "@solana/web3.js";
import { Principal } from "@dfinity/principal";
import chainConfig from "virtual:crown-config";

import {
  type CrownIndexActor,
  type FundingActor,
  type SubscriptionActor,
  type TasksActor,
  agentFor,
  crownIndexActor,
  fundingActor,
  subscriptionActor,
  tasksActor,
} from "./canisters.ts";
import type { ChainAddresses } from "./ix.ts";
import { type Signer, burnerSigner, loadBurners } from "./signer.ts";

export type CanisterName = "crownIndex" | "conditionalTasks" | "conditionalFunding" | "subscription";

const OVERRIDE_KEY = "crown-lab:canisters";

/** Canister ids: the baked profile first, then whatever the page was told. */
export function canisterIds(): Record<CanisterName, string> {
  const baked = chainConfig;
  const stored = JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? "{}") as Partial<
    Record<CanisterName, string>
  >;
  return {
    crownIndex: stored.crownIndex || baked.crownIndex,
    conditionalTasks: stored.conditionalTasks || baked.conditionalTasks,
    conditionalFunding: stored.conditionalFunding || baked.conditionalFunding,
    subscription: stored.subscription || baked.subscription,
  };
}

export function setCanisterId(name: CanisterName, id: string): void {
  const stored = JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? "{}") as Record<string, string>;
  stored[name] = id.trim();
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(stored));
}

export interface Lab {
  profile: string;
  chainId: string;
  /** "solana-devnet" — the book's key and the domain suffix. */
  connection: Connection;
  addresses: ChainAddresses;
  /** The games' price tag; every escrow they recognize is born with it. */
  feeBps: number;
  feeWallet: PublicKey;
  domains: { twoOutcome: string; stream: string };
  icHost: string;
  ids: Record<CanisterName, string>;
  index: CrownIndexActor | null;
  tasks: TasksActor | null;
  funding: FundingActor | null;
  subscription: SubscriptionActor | null;
  /** Raw principal bytes, as the signed messages frame them. */
  principalBytes(name: CanisterName): Uint8Array;
  participants: Signer[];
  /** Re-render everything; panels call this after an action changes state. */
  refresh(): void;
}

export async function buildLab(refresh: () => void): Promise<Lab> {
  const config = chainConfig;
  const ids = canisterIds();
  const agent = await agentFor(config.icHost || "http://127.0.0.1:4943");

  return {
    profile: config.profile,
    chainId: config.chainId,
    connection: new Connection(config.rpc, "confirmed"),
    addresses: {
      splitter: new PublicKey(config.splitter),
      usdc: new PublicKey(config.usdc),
      factoryTwoOutcome: new PublicKey(config.factoryTwoOutcome),
      factoryStream: new PublicKey(config.factoryStream),
    },
    feeBps: config.feeBps,
    feeWallet: new PublicKey(config.feeWallet),
    domains: {
      twoOutcome: `crown:two-outcome:${config.chainId}`,
      stream: `crown:stream:${config.chainId}`,
    },
    icHost: config.icHost,
    ids,
    index: ids.crownIndex ? crownIndexActor(agent, ids.crownIndex) : null,
    tasks: ids.conditionalTasks ? tasksActor(agent, ids.conditionalTasks) : null,
    funding: ids.conditionalFunding ? fundingActor(agent, ids.conditionalFunding) : null,
    subscription: ids.subscription ? subscriptionActor(agent, ids.subscription) : null,
    principalBytes: (name) => {
      const id = ids[name];
      if (!id) throw new Error(`canister id для ${name} не задан`);
      return Principal.fromText(id).toUint8Array();
    },
    participants: loadBurners().map(burnerSigner),
    refresh,
  };
}

/** Connected wallets live for the page's lifetime, not in storage. */
export const connectedWallets: Signer[] = [];

export function allParticipants(lab: Lab): Signer[] {
  return [...connectedWallets, ...lab.participants];
}

export function participantByAddress(lab: Lab, address: string): Signer {
  const found = allParticipants(lab).find((signer) => signer.address === address);
  if (!found) throw new Error(`участник ${address} не подключён`);
  return found;
}
