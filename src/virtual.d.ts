// The chain profile, supplied by the crown-config plugin in vite.config.ts
// from config/<CROWN_PROFILE>.toml at dev and build time alike.
declare module "virtual:crown-config" {
  const config: {
    profile: string;
    chainId: string;
    rpc: string;
    splitter: string;
    usdc: string;
    factoryTwoOutcome: string;
    factoryStream: string;
    feeBps: number;
    feeWallet: string;
    icHost: string;
    crownIndex: string;
    conditionalTasks: string;
    conditionalFunding: string;
    auction: string;
    subscription: string;
  };
  export default config;
}
