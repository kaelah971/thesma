/**
 * Injected-wallet discovery for funding (client only, framework-free).
 *
 * Modern browsers may host several wallet extensions at once, and
 * extensions can inject after first render — so `window.ethereum` alone is
 * not MetaMask, and a first-render miss is not proof of absence.
 *
 * Discovery order:
 *  1. `window.ethereum.providers[]` — explicit MetaMask entry wins.
 *  2. `window.ethereum` itself (MetaMask or another injected wallet).
 *  3. EIP-6963 announcements (`eip6963:requestProvider` round-trip).
 *
 * Nothing here signs, sends, or stores. All account reads use the
 * non-prompting `eth_accounts` unless the caller explicitly connects.
 * No timers longer than the discovery round-trip; no cached verdicts —
 * every funding attempt re-discovers.
 */

export interface WalletRequest {
  (args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface InjectedProvider {
  request: WalletRequest;
  isMetaMask?: boolean;
  providers?: InjectedProvider[];
  [key: string]: unknown;
}

export interface DiscoveredWallet {
  provider: InjectedProvider;
  /** Human label. Truthful: "MetaMask" only for an explicit MetaMask provider. */
  name: string;
  isMetaMask: boolean;
  source: "providers" | "injected" | "eip6963";
}

export interface EIP6963Info {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface EIP6963Detail {
  info: EIP6963Info;
  provider: InjectedProvider;
}

function eth(): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: InjectedProvider };
  return w?.ethereum ?? null;
}

function labelFor(provider: InjectedProvider, fallback: string): { name: string; isMetaMask: boolean } {
  if (provider?.isMetaMask === true) return { name: "MetaMask", isMetaMask: true };
  return { name: fallback, isMetaMask: false };
}

/**
 * Synchronous pass over already-injected providers. Multi-wallet safe:
 * an explicit MetaMask entry wins even when it is not first.
 */
export function pickInjectedWallet(): DiscoveredWallet | null {
  const root = eth();
  if (!root) return null;
  const list = Array.isArray(root.providers) ? root.providers : null;
  if (list && list.length > 0) {
    const meta = list.find((p) => p?.isMetaMask === true) ?? list[0];
    if (!meta || typeof meta.request !== "function") return null;
    const labeled = labelFor(meta, "Injected wallet");
    return { provider: meta, name: labeled.name, isMetaMask: labeled.isMetaMask, source: "providers" };
  }
  if (typeof root.request !== "function") return null;
  const labeled = labelFor(root, "Injected wallet");
  return { provider: root, name: labeled.name, isMetaMask: labeled.isMetaMask, source: "injected" };
}

function isMetaMaskDetail(d: EIP6963Detail | null | undefined): boolean {
  if (!d) return false;
  return /metamask/i.test(d.info?.rdns ?? "") || /metamask/i.test(d.info?.name ?? "");
}

/** Filter EIP-6963 announcements down to MetaMask entries. */
export function findMetaMask6963(details: EIP6963Detail[]): EIP6963Detail | null {
  if (!Array.isArray(details)) return null;
  return details.find((d) => d && typeof d.provider?.request === "function" && isMetaMaskDetail(d)) ?? null;
}

/**
 * Full discovery: synchronous providers first, then one EIP-6963
 * round-trip (bounded by timeoutMs), then a final synchronous re-check to
 * catch delayed injection that landed during the round-trip.
 */
export async function discoverWallet(timeoutMs = 700): Promise<DiscoveredWallet | null> {
  const sync = pickInjectedWallet();
  if (sync) return sync;
  if (typeof window === "undefined") return null;
  const collected: EIP6963Detail[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<EIP6963Detail>).detail;
    if (detail && typeof detail.provider?.request === "function") collected.push(detail);
  };
  try {
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
  } catch {
    return pickInjectedWallet();
  } finally {
    try {
      window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    } catch {
      // Listener cleanup is best-effort; discovery continues below.
    }
  }
  const late = pickInjectedWallet();
  if (late) return late;
  const meta = findMetaMask6963(collected);
  if (meta) return { provider: meta.provider, name: "MetaMask", isMetaMask: true, source: "eip6963" };
  const first = collected.find((d) => d && typeof d.provider?.request === "function") ?? null;
  if (first) {
    const name = typeof first.info?.name === "string" && first.info.name ? first.info.name : "Injected wallet";
    return { provider: first.provider, name, isMetaMask: false, source: "eip6963" };
  }
  return null;
}

export type WalletPresence = "NOT_INSTALLED" | "DISCONNECTED" | "WRONG_NETWORK" | "READY";
export type WalletFailure = "USER_REJECTED" | "NO_ACCOUNT" | "PROVIDER_ERROR" | "CHAIN_NOT_ADDED";

export function isUserRejection(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (anyErr.code === 4001 || anyErr.code === "4001" || anyErr.code === "ACTION_REJECTED") return true;
  const msg = typeof anyErr.message === "string" ? anyErr.message : String(err);
  return /user rejected|rejected the request|denied|user denied/i.test(msg);
}

function failureOf(err: unknown): WalletFailure {
  return isUserRejection(err) ? "USER_REJECTED" : "PROVIDER_ERROR";
}

/**
 * Silent state probe. Never prompts: `eth_accounts` only. Distinguishes
 * NOT_INSTALLED (no discoverable provider), DISCONNECTED (provider present,
 * zero accounts), WRONG_NETWORK and READY against expectedChainId.
 */
export async function getWalletState(
  provider: InjectedProvider,
  expectedChainId: number,
): Promise<{ state: WalletPresence; account: string | null; chainId: string | null; failure?: WalletFailure }> {
  if (!provider || typeof provider.request !== "function") {
    return { state: "NOT_INSTALLED", account: null, chainId: null };
  }
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_accounts" });
  } catch (err) {
    return { state: "DISCONNECTED", account: null, chainId: null, failure: failureOf(err) };
  }
  const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? (accounts[0] as string) : null;
  if (!account) return { state: "DISCONNECTED", account: null, chainId: null };
  let chainId: unknown;
  try {
    chainId = await provider.request({ method: "eth_chainId" });
  } catch (err) {
    return { state: "DISCONNECTED", account, chainId: null, failure: failureOf(err) };
  }
  const expectedHex = `0x${expectedChainId.toString(16)}`;
  if (typeof chainId !== "string" || chainId.toLowerCase() !== expectedHex.toLowerCase()) {
    return { state: "WRONG_NETWORK", account, chainId: typeof chainId === "string" ? chainId : null };
  }
  return { state: "READY", account, chainId: typeof chainId === "string" ? chainId : null };
}

/**
 * Explicit user-gesture connect. Prompts `eth_requestAccounts` exactly once.
 * 4001-style rejections map to USER_REJECTED — never to NOT_INSTALLED.
 */
export async function connectWallet(
  provider: InjectedProvider,
): Promise<{ account: string } | { failure: WalletFailure }> {
  if (!provider || typeof provider.request !== "function") return { failure: "PROVIDER_ERROR" };
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (err) {
    return { failure: failureOf(err) };
  }
  const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? (accounts[0] as string) : null;
  if (!account) return { failure: "NO_ACCOUNT" };
  return { account };
}

export function chainHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/**
 * Ask the wallet to switch chains. Returns CHAIN_NOT_ADDED when the wallet
 * does not know the chain (4902) — the UI then explains how to add Arc
 * Mainnet manually instead of failing with a raw code. Never invents RPC
 * URLs: adding an unknown chain is the user's explicit wallet action.
 */
export async function switchToNetwork(
  provider: InjectedProvider,
  chainId: number,
): Promise<{ switched: true } | { failure: WalletFailure }> {
  if (!provider || typeof provider.request !== "function") return { failure: "PROVIDER_ERROR" };
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainHex(chainId) }],
    });
    return { switched: true };
  } catch (err) {
    if (isUserRejection(err)) return { failure: "USER_REJECTED" };
    const code = (err as { code?: unknown })?.code;
    if (code === 4902 || code === "4902") return { failure: "CHAIN_NOT_ADDED" };
    return { failure: "PROVIDER_ERROR" };
  }
}

/** Truncated address for display. Full values stay in transaction params only. */
export function truncateAddress(address: string | null | undefined): string {
  if (!address || address.length < 10) return address ?? "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
