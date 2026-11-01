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
 * Nothing here signs, sends, or stores. No secret key material is ever
 * handled. All account reads use the non-prompting `eth_accounts`
 * unless the caller explicitly connects.
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
  /** MetaMask UI-selected account (when exposed). Never assumed — always validated against eth_accounts. */
  selectedAddress?: unknown;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  [key: string]: unknown;
}

export interface DiscoveredWallet {
  provider: InjectedProvider;
  /** Human label. Truthful: "MetaMask" only for an explicit MetaMask provider. */
  name: string;
  isMetaMask: boolean;
  source: "providers" | "injected" | "eip6963";
  /** EIP-6963 announcement info when source === "eip6963"; null otherwise. Diagnostic only. */
  info?: EIP6963Info | null;
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
 * Full discovery. Never assumes `window.ethereum` is MetaMask and never
 * assumes `accounts[0]` is the user's selected account (a stale permitted
 * account can sit at index 0 while the UI shows another one).
 *
 * Order: explicit MetaMask providers[] entry → MetaMask window.ethereum
 * fast path → EIP-6963 MetaMask round-trip → legacy injected fallback.
 * Ends with a synchronous re-check to catch delayed injection.
 */
export async function discoverWallet(timeoutMs = 700): Promise<DiscoveredWallet | null> {
  const sync = pickInjectedWallet();
  // Fast path only for an explicitly MetaMask root.
  if (sync?.isMetaMask) return sync;
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
  if (late?.isMetaMask) return late;
  const meta = findMetaMask6963(collected);
  if (meta) return { provider: meta.provider, name: "MetaMask", isMetaMask: true, source: "eip6963", info: meta.info ?? null };
  // Legacy fallback: a usable injected root even when it is not MetaMask.
  if (late) return late;
  const first = collected.find((d) => d && typeof d.provider?.request === "function") ?? null;
  if (first) {
    const name = typeof first.info?.name === "string" && first.info.name ? first.info.name : "Injected wallet";
    return { provider: first.provider, name, isMetaMask: false, source: "eip6963", info: first.info ?? null };
  }
  return sync;
}

export type WalletPresence = "NOT_INSTALLED" | "DISCONNECTED" | "WRONG_NETWORK" | "READY";
export type WalletFailure =
  | "USER_REJECTED"
  | "REQUEST_ALREADY_PENDING"
  | "PERMISSION_REQUIRED"
  | "PROVIDER_DISCONNECTED"
  | "SECURITY_BLOCKED"
  | "NO_ACCOUNT"
  | "PROVIDER_ERROR"
  | "CHAIN_NOT_ADDED";

export function errorCodeOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && /^-?\d+$/.test(code.trim())) return Number.parseInt(code.trim(), 10);
  return null;
}

export function errorMessageOf(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const anyErr = err as { message?: unknown };
  return typeof anyErr.message === "string" ? anyErr.message : String(err);
}

export function isUserRejection(err: unknown): boolean {
  if (!err) return false;
  if (errorCodeOf(err) === 4001) return true;
  const anyErr = err as { code?: unknown };
  if (anyErr.code === "ACTION_REJECTED") return true;
  return /user rejected|rejected the request|user denied/i.test(errorMessageOf(err));
}

/** Site-block / phishing-warning refusal. Never claim bypass; surface neutrally. */
export function isSecurityBlocked(err: unknown): boolean {
  return /phish|deceptive|malici|dangerous|fraud|scam|suspicious|not allowed to connect|site.{0,20}block|block.{0,20}site/i.test(
    errorMessageOf(err),
  );
}

export function isRequestPending(err: unknown): boolean {
  if (errorCodeOf(err) === -32002) return true;
  return /already processing|request already pending|already pending/i.test(errorMessageOf(err));
}

export function isPermissionIssue(err: unknown): boolean {
  if (errorCodeOf(err) === 4100) return true;
  return /unauthori[sz]ed|not been authori[sz]ed|no permissions|missing permissions/i.test(errorMessageOf(err));
}

export function isProviderDisconnected(err: unknown): boolean {
  const code = errorCodeOf(err);
  if (code === 4900 || code === 4901) return true;
  return /\bdisconnected\b|connection (lost|closed)|provider (closed|lost)/i.test(errorMessageOf(err));
}

function failureOf(err: unknown): WalletFailure {
  if (isUserRejection(err)) return "USER_REJECTED";
  if (isRequestPending(err)) return "REQUEST_ALREADY_PENDING";
  if (isSecurityBlocked(err)) return "SECURITY_BLOCKED";
  if (isPermissionIssue(err)) return "PERMISSION_REQUIRED";
  if (isProviderDisconnected(err)) return "PROVIDER_DISCONNECTED";
  return "PROVIDER_ERROR";
}

/**
 * Truthful, non-technical copy per failure. Never claims "locked" without
 * evidence, never exposes raw provider objects or stack traces, and never
 * instructs the user to bypass a wallet security warning.
 */
export function connectionFailureCopy(failure: WalletFailure, walletName: string): string {
  switch (failure) {
    case "USER_REJECTED":
      return "Connection request was rejected. Try again when ready.";
    case "REQUEST_ALREADY_PENDING":
      return "A wallet connection request is already open. Finish or cancel it in the wallet, then try again.";
    case "PERMISSION_REQUIRED":
      return `${walletName} did not grant access to any account. Approve access in the wallet, then try again.`;
    case "PROVIDER_DISCONNECTED":
      return "The wallet provider disconnected. Reopen the wallet and try again.";
    case "SECURITY_BLOCKED":
      return "The wallet is currently preventing this site from connecting. No wallet was registered.";
    case "NO_ACCOUNT":
      return "No account was returned. Select an account in the wallet, then try again.";
    case "CHAIN_NOT_ADDED":
      return `The wallet does not know this network yet. Add it in ${walletName}, then try again.`;
    case "PROVIDER_ERROR":
    default:
      return `${walletName} could not connect because of a provider error. Try again.`;
  }
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
 * Explicit user-gesture connect. Silent `eth_accounts` probe FIRST: when an
 * account is already available no `eth_requestAccounts` prompt is sent at
 * all. Only a truly empty result triggers one permission request — exactly
 * once, never in a loop. Failures map to precise states, never to a
 * generic "unlock" claim.
 */
export async function connectWallet(
  provider: InjectedProvider,
): Promise<{ account: string } | { failure: WalletFailure }> {
  if (!provider || typeof provider.request !== "function") return { failure: "PROVIDER_ERROR" };
  let existing: unknown;
  try {
    existing = await provider.request({ method: "eth_accounts" });
  } catch (err) {
    return { failure: failureOf(err) };
  }
  const available = Array.isArray(existing) ? existing.filter((a): a is string => typeof a === "string") : [];
  if (available.length > 0) return { account: available[0] };
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

/**
 * EIP-712 typed-data ownership proof for company-wallet registration.
 *
 * Structured data (not an opaque personal_sign blob) so wallets render a
 * human-readable request instead of a high-risk warning. The domain pins
 * Thesma + Arc Mainnet; the message binds workspace + wallet + a
 * server-issued single-use nonce with expiry. No verifyingContract: this
 * proof authorizes no contract call, fund movement, or token approval —
 * chainId + purpose make that explicit on every signer UI.
 */
export const COMPANY_WALLET_DOMAIN = {
  name: "Thesma",
  version: "1",
  chainId: 5042,
} as const;

export const COMPANY_WALLET_REGISTRATION_TYPES: Record<string, { name: string; type: string }[]> = {
  // Explicit EIP712Domain: MetaMask's eth_signTypedData_v4 implementation
  // hashes the RAW RPC payload and requires this type to be present.
  // Viem infers the domain type from the `domain` object, so viem-only
  // digests matched even without it — while MetaMask signed a DIFFERENT
  // digest (valid signature, wrong recovered signer). The canonical
  // payload below is the single source of truth: server challenge,
  // browser verbatim signing, diagnostics hashing, server recovery.
  // No verifyingContract: the domain genuinely has none.
  // NOTE: intentionally a loose Record (not `as const`) so viem keeps its
  // generic domain typing (numeric chainId); the runtime value is what
  // MetaMask hashes, and golden tests pin it byte-for-byte.
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
  CompanyWalletRegistration: [
    { name: "workspaceId", type: "string" },
    { name: "purpose", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
    { name: "expiresAt", type: "string" },
  ],
};

export const COMPANY_WALLET_PURPOSE =
  "Register this wallet as the organization's company wallet for Thesma campaign funding. This never moves funds.";

export interface CompanyWalletTypedMessage {
  workspaceId: string;
  purpose: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CompanyWalletTypedData {
  domain: typeof COMPANY_WALLET_DOMAIN;
  types: typeof COMPANY_WALLET_REGISTRATION_TYPES;
  primaryType: "CompanyWalletRegistration";
  message: CompanyWalletTypedMessage;
}

/**
 * Canonical typed-data payload. Frontend and server MUST build it here.
 *
 * Deliberately NOT wallet-bound: the cryptographic signer IS the identity.
 * Binding the message to a client-selected address reintroduced the
 * accounts[0] mismatch loop, so the server recovers the actual signer and
 * the user confirms THAT wallet explicitly before anything is stored.
 */
export function buildCompanyWalletTypedData(args: {
  workspaceId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): CompanyWalletTypedData {
  return {
    domain: COMPANY_WALLET_DOMAIN,
    types: COMPANY_WALLET_REGISTRATION_TYPES,
    primaryType: "CompanyWalletRegistration",
    message: {
      workspaceId: args.workspaceId,
      purpose: COMPANY_WALLET_PURPOSE,
      nonce: args.nonce,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    },
  };
}

/**
 * Ask the connected wallet to sign the registration typed data
 * (eth_signTypedData_v4). Proves control without secret key material and
 * without any transaction — a signature, never a broadcast.
 *
 * Legacy shape (`{ failure: WalletFailure }`) is preserved for existing
 * callers. New code should prefer signCompanyWalletTypedDataDetailed,
 * which reports the exact normalized provider error.
 */
export async function signCompanyWalletTypedData(
  provider: InjectedProvider,
  account: string,
  typedData: CompanyWalletTypedData,
): Promise<{ signature: string } | { failure: WalletFailure }> {
  if (!provider || typeof provider.request !== "function") return { failure: "PROVIDER_ERROR" };
  try {
    const signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)],
    })) as unknown;
    if (typeof signature !== "string" || !signature.startsWith("0x")) return { failure: "PROVIDER_ERROR" };
    return { signature };
  } catch (err) {
    return { failure: failureOf(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Temporary owner-only signature-failure diagnosis (P0).               */
/* One explicit click → one eth_signTypedData_v4 request, no retries.   */
/* Only safe fields (code, rpcCode, message) are ever surfaced.         */
/* Never: signature, nonce, tokens, cookies, stack, raw error object.  */
/* ------------------------------------------------------------------ */

export type SignClassification =
  | "USER_REJECTED"
  | "REQUEST_ALREADY_PENDING"
  | "UNAUTHORIZED"
  | "SECURITY_BLOCKED"
  | "PROVIDER_INTERNAL_ERROR"
  | "UNSUPPORTED_METHOD"
  | "INVALID_PARAMS"
  | "ACCOUNT_CHANGED"
  | "UNKNOWN_SIGNING_ERROR";

/** Safe, renderable subset of a provider signing error. No raw object. */
export interface SafeSignError {
  code: number | string | null;
  rpcCode: number | string | null;
  /** Sanitized message: redacted, truncated, single-line. */
  message: string;
  classification: SignClassification;
}

/**
 * Inner RPC code for wrapped provider errors (e.g. outer code 53 with an
 * inner 4001 cancellation). Checks common nesting shapes; numeric strings
 * are parsed. Returns null when no inner code is present.
 */
export function signRpcCodeOf(err: unknown): number | string | null {
  if (!err || typeof err !== "object") return null;
  const anyErr = err as Record<string, unknown>;
  const candidates: unknown[] = [
    anyErr.rpcCode,
    (anyErr.data as { rpcCode?: unknown } | null)?.rpcCode,
    (anyErr.error as { code?: unknown } | null)?.code,
    (anyErr.cause as { code?: unknown } | null)?.code,
    (anyErr.data as { code?: unknown } | null)?.code,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c)) return c;
    if (typeof c === "string" && /^-?\d+$/.test(c.trim())) return Number.parseInt(c.trim(), 10);
  }
  return null;
}

/** Security-layer refusal text (Blockaid / phishing / deceptive site). */
function isSecurityRefusalMessage(message: string): boolean {
  return /phish|deceptive|malici|dangerous|fraud|scam|suspicious|blockaid|secur/i.test(message);
}

/**
 * Normalize a thrown eth_signTypedData_v4 provider error to a stable
 * classification. Priority: explicit cancellations first, then the
 * security layer (which can ride on generic codes), then known RPC codes,
 * then account-change text, else unknown. Never throws.
 */
export function classifySignError(err: unknown): SignClassification {
  try {
    const code = errorCodeOf(err);
    const rpc = signRpcCodeOf(err);
    const msg = errorMessageOf(err);
    // Wrapped cancellation: outer 53 carrying an inner 4001.
    if (code === 53 && rpc === 4001) return "USER_REJECTED";
    if (code === 4001 || rpc === 4001) return "USER_REJECTED";
    if (isUserRejection(err)) return "USER_REJECTED";
    // Security layer can accompany generic codes — check before them.
    if (isSecurityRefusalMessage(msg) || isSecurityBlocked(err)) return "SECURITY_BLOCKED";
    if (code === -32002 || rpc === -32002) return "REQUEST_ALREADY_PENDING";
    if (isRequestPending(err)) return "REQUEST_ALREADY_PENDING";
    if (code === 4100 || rpc === 4100) return "UNAUTHORIZED";
    if (code === 4200 || rpc === 4200) return "UNSUPPORTED_METHOD";
    if (code === -32602 || rpc === -32602) return "INVALID_PARAMS";
    if (code === -32603 || rpc === -32603) return "PROVIDER_INTERNAL_ERROR";
    if (/unknown account|account (changed|mismatch)|selected account/i.test(msg)) return "ACCOUNT_CHANGED";
    return "UNKNOWN_SIGNING_ERROR";
  } catch {
    return "UNKNOWN_SIGNING_ERROR";
  }
}

/**
 * Sanitized provider message for the owner-only panel: hex material
 * redacted, whitespace collapsed, truncated. Never includes a stack.
 */
export function safeSignMessage(err: unknown, maxLen = 280): string {
  let msg = errorMessageOf(err);
  msg = msg.replace(/0x[0-9a-fA-F]{32,}/g, "[redacted]");
  msg = msg.replace(/\s+/g, " ").trim();
  if (!msg) return "The wallet returned an error with no message.";
  const limit = Math.max(40, maxLen);
  if (msg.length > limit) return `${msg.slice(0, limit - 1)}…`;
  return msg;
}

/** Extract only safe fields from a thrown signing error. Never throws. */
export function normalizeSignError(err: unknown): SafeSignError {
  try {
    return {
      code: errorCodeOf(err),
      rpcCode: signRpcCodeOf(err),
      message: safeSignMessage(err),
      classification: classifySignError(err),
    };
  } catch {
    return { code: null, rpcCode: null, message: "The wallet returned an unreadable error.", classification: "UNKNOWN_SIGNING_ERROR" };
  }
}

/**
 * Truthful user-facing copy per signing classification. Security copy never
 * suggests bypassing the wallet warning; nothing here exposes codes,
 * objects, or secrets beyond the separate owner-only diagnostic fields.
 */
export function signFailureCopy(classification: SignClassification, walletName = "MetaMask"): string {
  switch (classification) {
    case "USER_REJECTED":
      return "Signature request was rejected. Nothing was registered.";
    case "REQUEST_ALREADY_PENDING":
      return "A MetaMask signature request is already open. Finish or cancel it in MetaMask, then try again.";
    case "UNAUTHORIZED":
      return `${walletName} has not authorized this account for the site. Reconnect the wallet and try again.`;
    case "UNSUPPORTED_METHOD":
      return `${walletName} did not support this signing request. No wallet was registered.`;
    case "INVALID_PARAMS":
      return "The signing request was rejected as invalid. No wallet was registered.";
    case "PROVIDER_INTERNAL_ERROR":
      return `${walletName} returned an internal signing error. No wallet was registered.`;
    case "SECURITY_BLOCKED":
      return `${walletName}'s security layer prevented the signature request. No wallet was registered.`;
    case "ACCOUNT_CHANGED":
      return "Your active wallet changed. Re-select the company wallet.";
    case "UNKNOWN_SIGNING_ERROR":
    default:
      return `${walletName} could not sign. Try again.`;
  }
}

/**
 * Exact-shape signing call with normalized failure detail. Exactly one
 * provider.request, method eth_signTypedData_v4, params [selected account,
 * JSON.stringify(frozen server typedData)] — no retry, no fallback method,
 * no transaction. On failure the caller receives only safe fields.
 */
export async function signCompanyWalletTypedDataDetailed(
  provider: InjectedProvider,
  account: string,
  typedData: CompanyWalletTypedData,
): Promise<{ signature: string } | { signError: SafeSignError }> {
  if (!provider || typeof provider.request !== "function") {
    return {
      signError: {
        code: null,
        rpcCode: null,
        message: "No signing provider is available.",
        classification: "UNKNOWN_SIGNING_ERROR",
      },
    };
  }
  try {
    const signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)],
    })) as unknown;
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      return {
        signError: {
          code: null,
          rpcCode: null,
          message: "The wallet returned an unexpected signing result.",
          classification: "UNKNOWN_SIGNING_ERROR",
        },
      };
    }
    return { signature };
  } catch (err) {
    return { signError: normalizeSignError(err) };
  }
}

/**
 * Provider/account consistency gate: the signer must still be the wallet the
 * user selected. Any change aborts before any challenge or signature.
 */
export function isAccountChanged(activeAccount: string | null, selectedAccount: string): boolean {
  if (!activeAccount) return true;
  return activeAccount.toLowerCase() !== selectedAccount.toLowerCase();
}

export interface RegistrationChallengePayload {
  typedData: CompanyWalletTypedData;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export type ChallengePayloadError = "NO_CHALLENGE" | "WORKSPACE_MISMATCH" | "ACCOUNT_CHANGED";

function sameAccount(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Explicit account selection. `accounts[0]` is never assumed to be the
 * user's selected account: when several accounts are permitted, the
 * wallet's UI-selected address (`selectedAddress`, when exposed and still
 * permitted) wins; otherwise the caller picks explicitly.
 */
export function defaultSelectedAccount(availableAccounts: string[], selectedAddress?: unknown): string | null {
  if (availableAccounts.length === 0) return null;
  if (typeof selectedAddress === "string" && selectedAddress) {
    const match = availableAccounts.find((a) => sameAccount(a, selectedAddress));
    if (match) return match;
  }
  return availableAccounts[0];
}

export interface AccountChangeResolution {
  changed: boolean;
  /** New selection when changed and non-empty; null when locked/empty. */
  selection: string | null;
}

/**
 * Pure accountsChanged reducer. Any membership change invalidates the
 * current selection flow: a non-empty new list moves the selection to the
 * wallet's freshly selected account (index 0); an empty list means locked.
 */
export function resolveAccountChange(previousAccounts: string[], nextAccounts: string[]): AccountChangeResolution {
  const sameSet =
    previousAccounts.length === nextAccounts.length &&
    previousAccounts.every((p) => nextAccounts.some((n) => sameAccount(p, n)));
  if (nextAccounts.length === 0) return { changed: true, selection: null };
  if (!sameSet) return { changed: true, selection: nextAccounts[0] };
  return { changed: false, selection: null };
}

/**
 * Frozen-challenge selector: the server-issued payload is the single source
 * of truth and is returned VERBATIM — never rebuilt, never recomputed.
 *
 * The client must not reconstruct nonce/issuedAt/expiresAt. Before returning
 * the payload, this asserts the explicitly selected account is still
 * permitted; otherwise the caller must restart with a fresh challenge,
 * never silently re-issue or silently switch accounts. (There is no wallet
 * field to compare: the recovered signer, not the selection, becomes the
 * registration identity at confirm time.)
 */
export function selectChallengePayload(args: {
  challenge: RegistrationChallengePayload | null;
  workspaceId: string;
  selectedAccount: string;
  availableAccounts: string[];
}): { typedData: CompanyWalletTypedData } | { error: ChallengePayloadError } {
  if (!args.challenge) return { error: "NO_CHALLENGE" };
  if (args.challenge.typedData.message.workspaceId !== args.workspaceId) return { error: "WORKSPACE_MISMATCH" };
  if (!args.availableAccounts.some((a) => sameAccount(a, args.selectedAccount))) return { error: "ACCOUNT_CHANGED" };
  return { typedData: args.challenge.typedData };
}

export type FundingEntryState = "REGISTER_REQUIRED" | "WRONG_ACCOUNT" | "OK";

/**
 * Pure entry gate for the funding flow. A missing registered wallet is its
 * own state — never mislabeled as "wrong account".
 */
export function fundingEntryState(args: {
  expectedSender: string | null;
  connectedAccount: string | null;
}): FundingEntryState {
  if (!args.expectedSender) return "REGISTER_REQUIRED";
  if (!args.connectedAccount || args.connectedAccount.toLowerCase() !== args.expectedSender.toLowerCase()) {
    return "WRONG_ACCOUNT";
  }
  return "OK";
}

/** Truncated address for display. Full values stay in transaction params only. */
export function truncateAddress(address: string | null | undefined): string {
  if (!address || address.length < 10) return address ?? "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Temporary owner-only provider-identity diagnostics (P0).             */
/* Read-only: never signs, sends, stores, or mutates selection.        */
/* No signatures, nonces, or secrets are captured here.                */
/* ------------------------------------------------------------------ */

/** One-line summary of an EIP-6963 announcement. No signing is ever invoked. */
export interface AnnouncedProviderSummary {
  name: string | null;
  rdns: string | null;
  uuid: string | null;
  isMetaMask: boolean;
}

/**
 * Pure list of every announced provider (no request calls, no signing).
 * Used to render "Injected providers discovered" without touching keys.
 */
export function summarizeAnnouncedProviders(details: EIP6963Detail[] | null | undefined): AnnouncedProviderSummary[] {
  if (!Array.isArray(details)) return [];
  return details
    .filter((d) => d && d.provider && typeof d.provider.request === "function")
    .map((d) => ({
      name: typeof d.info?.name === "string" && d.info.name ? d.info.name : null,
      rdns: typeof d.info?.rdns === "string" && d.info.rdns ? d.info.rdns : null,
      uuid: typeof d.info?.uuid === "string" && d.info.uuid ? d.info.uuid : null,
      isMetaMask: d.provider?.isMetaMask === true || isMetaMaskDetail(d),
    }));
}

/** window.ethereum snapshot relative to the selected provider. Sync, read-only. */
export interface WindowEthereumSnapshot {
  hasWindow: boolean;
  hasEthereum: boolean;
  /** window.ethereum === selectedProvider (object identity). Null when no selection. */
  sameAsSelected: boolean | null;
  /** window.ethereum.providers?.length when an array; null otherwise. */
  providersCount: number | null;
}

/**
 * Snapshot window.ethereum without prompting or signing. Pure reads of
 * object identity and providers[] length only.
 */
export function snapshotWindowEthereum(selectedProvider: InjectedProvider | null): WindowEthereumSnapshot {
  if (typeof window === "undefined") {
    return { hasWindow: false, hasEthereum: false, sameAsSelected: null, providersCount: null };
  }
  const w = window as unknown as { ethereum?: InjectedProvider };
  const root = w?.ethereum ?? null;
  if (!root) return { hasWindow: true, hasEthereum: false, sameAsSelected: null, providersCount: null };
  const list = Array.isArray(root.providers) ? root.providers : null;
  return {
    hasWindow: true,
    hasEthereum: true,
    sameAsSelected: selectedProvider ? root === (selectedProvider as unknown) : null,
    providersCount: list ? list.length : null,
  };
}

/** Which provider object handled one JSON-RPC method. */
export interface ProviderRequestLogEntry {
  method: string;
  /** Human label of the handling provider (no addresses, no secrets). */
  handledBy: string;
  /** True when the handler is the selected provider object (identity check). */
  sameAsSelected: boolean;
}

export type TracedWalletMethod =
  | "eth_accounts"
  | "eth_requestAccounts"
  | "eth_chainId"
  | "eth_signTypedData_v4";

const TRACED_METHODS: ReadonlySet<string> = new Set([
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "eth_signTypedData_v4",
]);

/** Stable label for a provider in request logs. Address-free. */
export function labelProviderForLog(provider: InjectedProvider | null, info?: EIP6963Info | null): string {
  if (!provider) return "<none>";
  const infoName = typeof info?.name === "string" && info.name ? info.name : null;
  const infoRdns = typeof info?.rdns === "string" && info.rdns ? ` (${info.rdns})` : "";
  if (provider.isMetaMask === true) return `MetaMask${infoName && infoName !== "MetaMask" ? ` / ${infoName}` : ""}${infoRdns}`;
  if (infoName) return `${infoName}${infoRdns}`;
  return "Injected wallet";
}

/**
 * Read-only request tracer. Wraps ONE selected provider so every tracked
 * method (eth_accounts, eth_requestAccounts, eth_chainId,
 * eth_signTypedData_v4) records which object handled it. Delegates 1:1 to
 * the target — no retry, no reorder, no selection change. The wrapper
 * exposes __target (the exact selected object) so tests and diagnostics can
 * assert `handler === selectedProvider` by identity.
 */
export function wrapProviderWithRequestLog(
  target: InjectedProvider,
  opts?: { label?: string; info?: EIP6963Info | null; log?: ProviderRequestLogEntry[] },
): InjectedProvider & { __target: InjectedProvider; __log: ProviderRequestLogEntry[] } {
  const log = opts?.log ?? [];
  const label = opts?.label ?? labelProviderForLog(target, opts?.info ?? null);
  const wrapped = {
    ...target,
    __target: target,
    __log: log,
    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      if (TRACED_METHODS.has(args?.method)) {
        log.push({ method: args.method, handledBy: label, sameAsSelected: true });
      }
      return target.request(args);
    },
    on(event: string, handler: (...a: unknown[]) => void) {
      return target.on?.(event, handler);
    },
    removeListener(event: string, handler: (...a: unknown[]) => void) {
      return target.removeListener?.(event, handler);
    },
  } as unknown as InjectedProvider & { __target: InjectedProvider; __log: ProviderRequestLogEntry[] };
  return wrapped;
}

/** Full identity snapshot for the temporary owner-only panel. No secrets. */
export interface SelectedProviderIdentity {
  /** EIP-6963 info when the selection came from an announcement; null otherwise. */
  infoName: string | null;
  infoRdns: string | null;
  infoUuid: string | null;
  isMetaMask: boolean;
  selectionSource: DiscoveredWallet["source"] | null;
  sameAsWindowEthereum: boolean | null;
  windowEthereumProvidersCount: number | null;
  accounts: string[] | null;
  selectedAddress: string | null;
  chainId: string | null;
}

/**
 * Diagnose the EXACT selected provider object. Read-only: eth_accounts +
 * eth_chainId only, never eth_signTypedData_v4, never eth_sendTransaction.
 * Returns full addresses (not secrets) so a collision is provable.
 */
export async function diagnoseSelectedProvider(
  provider: InjectedProvider | null,
  opts?: { info?: EIP6963Info | null; source?: DiscoveredWallet["source"] | null },
): Promise<SelectedProviderIdentity> {
  const base: SelectedProviderIdentity = {
    infoName: typeof opts?.info?.name === "string" && opts.info.name ? opts.info.name : null,
    infoRdns: typeof opts?.info?.rdns === "string" && opts.info.rdns ? opts.info.rdns : null,
    infoUuid: typeof opts?.info?.uuid === "string" && opts.info.uuid ? opts.info.uuid : null,
    isMetaMask: provider?.isMetaMask === true,
    selectionSource: opts?.source ?? null,
    sameAsWindowEthereum: null,
    windowEthereumProvidersCount: null,
    accounts: null,
    selectedAddress:
      typeof provider?.selectedAddress === "string" && provider.selectedAddress ? (provider.selectedAddress as string) : null,
    chainId: null,
  };
  if (!provider || typeof provider.request !== "function") return base;
  try {
    const snap = snapshotWindowEthereum(provider);
    base.sameAsWindowEthereum = snap.sameAsSelected;
    base.windowEthereumProvidersCount = snap.providersCount;
  } catch {
    // Snapshot is best-effort; account reads continue below.
  }
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as unknown;
    base.accounts = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === "string") : null;
  } catch {
    base.accounts = null;
  }
  try {
    const chainId = (await provider.request({ method: "eth_chainId" })) as unknown;
    base.chainId = typeof chainId === "string" ? chainId : null;
  } catch {
    base.chainId = null;
  }
  return base;
}

/**
 * Collect every EIP-6963 announcement WITHOUT selecting or signing.
 * Diagnostic only: returns raw details so the UI can list name/rdns/uuid
 * for each discovered provider. Never calls provider.request.
 */
export async function collectEIP6963Announcements(timeoutMs = 700): Promise<EIP6963Detail[]> {
  if (typeof window === "undefined") return [];
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
    return collected;
  } finally {
    try {
      window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    } catch {
      // Best-effort cleanup.
    }
  }
  return collected;
}
