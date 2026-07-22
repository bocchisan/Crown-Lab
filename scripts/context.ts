// Shared bootstrap for the headless runs: the profile the page is built from,
// the actors, the connection, and the e2e keypairs driven through the very
// same burner signer the page uses.
//
// These runs deliberately do NOT touch the replica. Each game's own
// e2e-devnet.sh starts with `dfx start --clean`, and the local network is
// shared: wiping it would destroy the threshold keys that are the resolvers of
// every live escrow on devnet, stranding real money until its deadline. So the
// lab verifies the same paths against the replica that is already up.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { HttpAgent } from "@dfinity/agent";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  type CrownIndexActor,
  type CrownRelayActor,
  type FundingActor,
  type SubscriptionActor,
  type TasksActor,
  crownIndexActor,
  crownRelayActor,
  fundingActor,
  subscriptionActor,
  tasksActor,
} from "../src/canisters.ts";
import type { ChainAddresses } from "../src/ix.ts";
import { type Signer, burnerSigner } from "../src/signer.ts";

export interface LabContext {
  chainId: string;
  connection: Connection;
  addresses: ChainAddresses;
  feeBps: number;
  feeWallet: PublicKey;
  domains: { twoOutcome: string; stream: string };
  ids: { crownIndex: string; crownRelay: string; tasks: string; funding: string; subscription: string };
  index: CrownIndexActor;
  relay: CrownRelayActor;
  tasks: TasksActor;
  funding: FundingActor;
  subscription: SubscriptionActor;
  donor: Signer;
  recipient: Signer;
}

function profile(): Record<string, string> {
  const toml = readFileSync(new URL("../config/local.toml", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of toml.split("\n")) {
    const match = /^(\w+)\s*=\s*"([^"]*)"/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) out[match[1]] = match[2];
  }
  return out;
}

function keypairSigner(path: string, label: string): Signer {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return burnerSigner({ label, secret: bs58.encode(Keypair.fromSecretKey(secret).secretKey) });
}

export async function context(): Promise<LabContext> {
  const cfg = profile();
  const chainId = cfg.id ?? "solana-devnet";
  const agent = await HttpAgent.create({ host: cfg.ic_host ?? "", shouldFetchRootKey: true });
  return {
    chainId,
    connection: new Connection(cfg.rpc ?? "", "confirmed"),
    addresses: {
      splitter: new PublicKey(cfg.splitter ?? ""),
      usdc: new PublicKey(cfg.usdc ?? ""),
      factoryTwoOutcome: new PublicKey(cfg.factory_two_outcome ?? ""),
      factoryStream: new PublicKey(cfg.factory_stream ?? ""),
    },
    feeBps: Number(cfg.fee_bps ?? "300"),
    feeWallet: new PublicKey(cfg.fee_wallet ?? ""),
    domains: { twoOutcome: `crown:two-outcome:${chainId}`, stream: `crown:stream:${chainId}` },
    ids: {
      crownIndex: cfg.crown_index ?? "",
      crownRelay: cfg.crown_relay ?? "",
      tasks: cfg.conditional_tasks ?? "",
      funding: cfg.conditional_funding ?? "",
      subscription: cfg.subscription ?? "",
    },
    index: crownIndexActor(agent, cfg.crown_index ?? ""),
    relay: crownRelayActor(agent, cfg.crown_relay ?? ""),
    tasks: tasksActor(agent, cfg.conditional_tasks ?? ""),
    funding: fundingActor(agent, cfg.conditional_funding ?? ""),
    subscription: subscriptionActor(agent, cfg.subscription ?? ""),
    donor: keypairSigner(`${homedir()}/.cache/crown-e2e/donor.json`, "донор"),
    // The keypair file keeps its historical name; only the role is named anew.
    recipient: keypairSigner(`${homedir()}/.cache/crown-e2e/streamer.json`, "получатель"),
  };
}

export const sleep = (seconds: number) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function show(message: Uint8Array): string {
  return `--- сообщение, которое подписывает кошелёк ---\n${new TextDecoder().decode(message)}---`;
}
