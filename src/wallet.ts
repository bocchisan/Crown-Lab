// Wallet Standard discovery — the only place that talks to browser wallets.
// Ported from the mini app's wallet.ts, including the lesson written into it:
// the Standard path is preferred because it is the only one that names the
// cluster, and wallets that guess it wrong reject devnet transactions as
// "network mismatch".

import { Transaction } from "@solana/web3.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

import type { Signer } from "./signer.ts";

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface SignMessageFeature {
  signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]>;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
  ): Promise<{ signedTransaction: Uint8Array }[]>;
}

const CONNECT = "standard:connect";
const EVENTS = "standard:events";
const SIGN_MESSAGE = "solana:signMessage";
const SIGN_TRANSACTION = "solana:signTransaction";

interface EventsFeature {
  on(event: "change", listener: (properties: { accounts?: readonly WalletAccount[] }) => void): () => void;
}

/** "solana-devnet" -> "solana:devnet", the Wallet Standard chain id. */
export function solanaChainOf(chainId: string): string {
  return chainId.replace("solana-", "solana:");
}

export interface DiscoveredWallet {
  name: string;
  icon: string;
  /** Why this wallet cannot be used, when it cannot; empty otherwise. */
  blocked: string;
  /** Every account the wallet hands over — a wallet may authorize several. */
  connect(): Promise<Signer[]>;
  /**
   * Fires when the extension's accounts change (the user switched account or
   * revoked one). Without it, switching account in Phantom leaves the page
   * signing as the old one.
   */
  onChange(listener: () => void): void;
}

/**
 * Extensions register themselves asynchronously, often after the page has
 * already rendered — without this the panel says "расширение не найдено" to
 * someone who has Phantom installed and open.
 */
export function onWalletsChanged(listener: () => void): void {
  const wallets = getWallets();
  wallets.on("register", listener);
  wallets.on("unregister", listener);
}

/**
 * The wallet's own injected provider. Kept as a fallback for wallets that do
 * not publish the Standard signing feature — Phantom and Solflare both still
 * expose these objects.
 */
interface LegacyProvider {
  connect?(): Promise<unknown>;
  publicKey?: { toBytes(): Uint8Array; toBase58(): string };
  signMessage?(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  signAllTransactions?(transactions: Transaction[]): Promise<Transaction[]>;
  signTransaction?(transaction: Transaction): Promise<Transaction>;
}

function legacyProviderOf(name: string): LegacyProvider | null {
  const scope = window as unknown as Record<string, LegacyProvider | undefined> & {
    phantom?: { solana?: LegacyProvider };
  };
  const lower = name.toLowerCase();
  const provider = lower.includes("solflare")
    ? scope.solflare
    : lower.includes("phantom")
      ? scope.phantom?.solana
      : lower.includes("brave")
        ? scope.braveSolana
        : undefined;
  return provider?.signAllTransactions || provider?.signTransaction ? provider : null;
}

/**
 * Every registered wallet, each with the reason it is unusable if it is.
 * Deliberately permissive: a wallet is listed even when it looks wrong, since
 * "Phantom is installed but the page does not show it" is impossible to debug
 * from the outside. The chain check accepts any Solana cluster — several
 * wallets advertise only `solana:mainnet` and still sign devnet fine.
 */
export function discoverWallets(solanaChain: string): DiscoveredWallet[] {
  return getWallets()
    .get()
    .filter((wallet) => wallet.chains.some((chain) => chain.startsWith("solana:")))
    .map((wallet) => {
      const missing: string[] = [];
      if (!(CONNECT in wallet.features)) missing.push("connect");
      if (!(SIGN_MESSAGE in wallet.features)) missing.push("signMessage");
      if (!(SIGN_TRANSACTION in wallet.features) && !legacyProviderOf(wallet.name)) {
        missing.push("signTransaction");
      }
      return {
        name: wallet.name,
        icon: wallet.icon,
        blocked: missing.length > 0 ? `нет ${missing.join(", ")}` : "",
        connect: () => connect(wallet, solanaChain),
        onChange: (listener) => {
          const events = wallet.features[EVENTS] as EventsFeature | undefined;
          events?.on("change", listener);
        },
      };
    });
}

/**
 * Connects and returns a signer per account. Accounts naming our cluster come
 * first, but none is dropped: several wallets list only `solana:mainnet` on
 * the account and still sign devnet fine, and refusing them would look to the
 * operator like the wallet simply does not work.
 */
async function connect(wallet: Wallet, solanaChain: string): Promise<Signer[]> {
  const { accounts } = await (wallet.features[CONNECT] as ConnectFeature).connect();
  if (accounts.length === 0) throw new Error(`${wallet.name}: кошелёк не дал ни одного аккаунта`);
  const ours = (account: WalletAccount): boolean =>
    account.chains.includes(solanaChain as WalletAccount["chains"][number]);
  const ordered = [...accounts].sort((a, b) => Number(ours(b)) - Number(ours(a)));
  return ordered.map((account) => signerOf(wallet, account, solanaChain));
}

function signerOf(wallet: Wallet, account: WalletAccount, solanaChain: string): Signer {
  const signMessageFeature = wallet.features[SIGN_MESSAGE] as SignMessageFeature | undefined;
  const signTransactionFeature = wallet.features[SIGN_TRANSACTION] as SignTransactionFeature | undefined;
  const provider = legacyProviderOf(wallet.name);

  return {
    kind: "wallet",
    // Several accounts of one wallet must not read as one participant.
    label: account.label ? `${wallet.name}: ${account.label}` : wallet.name,
    address: account.address,
    publicKey: new Uint8Array(account.publicKey),
    async signMessage(message) {
      if (signMessageFeature) {
        const [out] = await signMessageFeature.signMessage({ account, message });
        if (!out) throw new Error("кошелёк не вернул подпись");
        return out.signature;
      }
      if (!provider?.signMessage) throw new Error(`${wallet.name}: не умеет подписывать сообщения`);
      // The canisters verify raw Ed25519 over the exact bytes, so the message
      // must go to the provider unencoded.
      const out = await provider.signMessage(message);
      return out instanceof Uint8Array ? out : out.signature;
    },
    async signTransactions(transactions) {
      if (transactions.length === 0) return [];
      // Standard first: it is the only path that names the cluster, and
      // wallets refuse transactions whose cluster they guess wrong.
      if (!signTransactionFeature) {
        if (!provider) throw new Error(`${wallet.name}: не умеет подписывать транзакции`);
        await provider.connect?.();
        const signed = provider.signAllTransactions
          ? await provider.signAllTransactions(transactions)
          : await Promise.all(
              transactions.map((transaction) => {
                if (!provider.signTransaction) throw new Error("кошелёк не умеет подписывать транзакции");
                return provider.signTransaction(transaction);
              }),
            );
        return signed.map((transaction) => new Uint8Array(transaction.serialize()));
      }
      const outputs = await signTransactionFeature.signTransaction(
        ...transactions.map((transaction) => ({
          account,
          chain: solanaChain,
          transaction: new Uint8Array(
            transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
          ),
        })),
      );
      return outputs.map((output) => {
        // Round-trip through web3.js so the wire bytes are canonical.
        return new Uint8Array(Transaction.from(output.signedTransaction).serialize());
      });
    },
  };
}
