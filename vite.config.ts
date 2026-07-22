// Bakes the profile into the bundle as a virtual module. CROWN_PROFILE picks
// the file; the default prefers config/local.toml (written by
// scripts/lab-up.sh with the live canister ids) and falls back to the
// committed testnet profile.
//
// A virtual module rather than `define`: vite 8 applies define only at build
// time, so a define-based config compiles, builds, and then throws
// "__CHAIN_CONFIG__ is not defined" the moment you run `vite dev` — which is
// how this page is meant to be used.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

function profileName(): string {
  if (process.env.CROWN_PROFILE) return process.env.CROWN_PROFILE;
  const local = fileURLToPath(new URL("./config/local.toml", import.meta.url));
  return existsSync(local) ? "local" : "testnet";
}

function chainConfig() {
  const profile = profileName();
  const toml = readFileSync(new URL(`./config/${profile}.toml`, import.meta.url), "utf8");
  const value = (key: string): string =>
    toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
  return {
    profile,
    chainId: value("id"),
    rpc: value("rpc"),
    splitter: value("splitter"),
    usdc: value("usdc"),
    factoryTwoOutcome: value("factory_two_outcome"),
    factoryStream: value("factory_stream"),
    feeBps: Number(value("fee_bps")),
    feeWallet: value("fee_wallet"),
    icHost: value("ic_host"),
    crownIndex: value("crown_index"),
    crownRelay: value("crown_relay"),
    conditionalTasks: value("conditional_tasks"),
    conditionalFunding: value("conditional_funding"),
    auction: value("auction"),
    subscription: value("subscription"),
  };
}

const VIRTUAL_ID = "virtual:crown-config";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export default defineConfig({
  plugins: [
    {
      name: "crown-config",
      resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : null),
      load: (id) => (id === RESOLVED_ID ? `export default ${JSON.stringify(chainConfig())};` : null),
    },
  ],
  base: "./",
  build: { target: "es2022" },
});
