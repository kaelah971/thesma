/** Same address, any checksum casing (EIP-55 case is error-detection, not identity). */
function isHexAddress(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
import {
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_USDC,
  assertAllowedUrl,
  assertTestnetTerms,
  normalizeProviderVerdict,
  parsePaymentRequired,
  type CheckType,
  type FetchImpl,
  type NormalizedResult,
  type VerificationQuote,
  type X402Accepted,
} from "./verification";

/**
 * Remote Arc-Testnet x402 provider (read challenge live, pay only on BUY).
 *
 * The 402 challenge is fetched and validated BEFORE any decision: network,
 * asset, scheme, positive integer amount, and payee are all checked here.
 * Nothing here signs, pays, or persists — it only produces a quote the
 * procurement kernel can price.
 */

export interface RemoteX402Terms {
  network: string;
  asset: string;
}

export interface RemoteX402QuoteParams {
  url: string;
  providerId: string;
  checkType: CheckType;
  campaignId: string;
  outcomeId: string;
  expected: RemoteX402Terms;
  allowedHosts: string[];
  fetchImpl?: FetchImpl;
  nowMs?: number;
  /** Quote time-to-live. Short and fail-closed (default 5 minutes). */
  quoteTtlMs?: number;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/** Pick the single testnet term. Rejects anything that is not exact-scheme canonical testnet USDC. */
export function selectRemoteX402Terms(
  terms: X402Accepted[],
  expected: RemoteX402Terms,
): X402Accepted {
  const match = terms.find(
    (t) =>
      t.network === expected.network &&
      t.asset.toLowerCase() === expected.asset.toLowerCase() &&
      t.scheme === "exact",
  );
  if (!match) {
    throw fail(400, "ASSET_OR_NETWORK_MISMATCH", "No accepted term matches the approved testnet asset/network with the exact scheme.");
  }
  let amount: bigint;
  try {
    amount = BigInt(match.amount);
  } catch {
    throw fail(400, "BAD_AMOUNT", "Accepted amount is not an integer.");
  }
  if (amount <= 0n) throw fail(400, "BAD_AMOUNT", "Accepted amount is not positive.");
  if (!isHexAddress(match.payTo)) throw fail(400, "PAYEE_MISMATCH", "Accepted payTo is not an address.");
  // Hard boundary: the ONLY spendable combination, regardless of caller config.
  assertTestnetTerms({ network: match.network, asset: match.asset });
  return match;
}

/**
 * Live 402 challenge → validated quote. The first GET never pays; a 200
 * means the resource is free (no purchase needed — caller decides).
 */
export async function fetchRemoteX402Quote(params: RemoteX402QuoteParams): Promise<{
  quote: VerificationQuote | null;
  freeResource: unknown;
}> {
  assertAllowedUrl(params.url, params.allowedHosts);
  const fetchImpl = params.fetchImpl ?? fetch;
  const nowMs = params.nowMs ?? Date.now();
  const first = await fetchImpl(params.url, { method: "GET", redirect: "manual" }).catch((e) => {
    throw fail(503, "PROVIDER_UNREACHABLE", `Provider request failed: ${(e as Error).message}`);
  });
  if (first.status >= 300 && first.status < 400) {
    throw fail(400, "UNTRUSTED_REDIRECT", "Provider redirects are not followed (SSRF guard).");
  }
  if (first.status !== 402) {
    if (!first.ok) throw fail(502, "PROVIDER_ERROR", `Provider returned ${first.status} without a payment requirement.`);
    return { quote: null, freeResource: await first.json().catch(() => null) };
  }
  const required = parsePaymentRequired(first.headers.get("payment-required"));
  // Resource binding: the challenge must name this endpoint's path.
  let pathOk = false;
  try {
    const fetched = new URL(params.url);
    const named = required.resource.url;
    const namedPath = named.startsWith("/") ? named : new URL(named).pathname;
    pathOk = namedPath === fetched.pathname;
  } catch {
    pathOk = false;
  }
  if (!pathOk) {
    throw fail(400, "RESOURCE_MISMATCH", "Payment requirement targets an unexpected resource.");
  }
  const terms = selectRemoteX402Terms(required.accepted, params.expected);
  const ttlMs = params.quoteTtlMs ?? 5 * 60_000;
  return {
    quote: {
      providerId: params.providerId,
      checkType: params.checkType,
      costMicroUsdc: BigInt(terms.amount),
      asset: terms.asset,
      network: terms.network,
      payTo: terms.payTo,
      resourceUrl: params.url,
      expiresAt: new Date(nowMs + ttlMs),
      quoteVersion: "remote-402-live",
    },
    freeResource: null,
  };
}

/* ---------------- GitHub repository evidence (scoped) ---------------- */

/** What this evidence MAY prove. Everything else is explicitly out of scope. */
export const GITHUB_REPO_EVIDENCE_CAPABILITY = "repository-identity-only";

export const GITHUB_REPO_EVIDENCE_DOES_NOT_PROVE = [
  "a customer purchased",
  "a PR was merged",
  "a user retained",
  "a creator caused revenue",
] as const;

export interface GithubRepoEvidenceInput {
  raw: unknown;
  expectedRepo: string;
  providerId: string;
}

export interface GithubRepoEvidence {
  normalized: NormalizedResult;
  identityMatch: boolean;
  capability: typeof GITHUB_REPO_EVIDENCE_CAPABILITY;
  summary: string;
}

/**
 * Normalize live GitHub repository metadata into scoped evidence.
 * Identity match is a positive existence signal ONLY — it can never
 * force VERIFIED, accuse anyone, or prove commercial outcomes.
 */
export function normalizeGithubRepoEvidence(input: GithubRepoEvidenceInput): GithubRepoEvidence {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const fullName = typeof raw.full_name === "string" ? raw.full_name : typeof raw.fullName === "string" ? raw.fullName : "";
  const identityMatch = fullName.toLowerCase() === input.expectedRepo.toLowerCase();
  const stars = typeof raw.stargazers_count === "number" ? raw.stargazers_count : null;
  const language = typeof raw.language === "string" ? raw.language : null;
  const normalized = normalizeProviderVerdict({
    providerId: input.providerId,
    verdict: identityMatch ? "clear" : "inconclusive",
    confidence: identityMatch ? "high" : "medium",
    reasonCodes: [identityMatch ? "github_repo_identity_match" : "github_repo_identity_mismatch"],
    evidenceRefs: fullName ? [fullName] : [],
    rawResponse: input.raw,
  });
  const parts = [`repository ${fullName || "<unknown>"} ${identityMatch ? "matches" : "does not match"} ${input.expectedRepo}`];
  if (stars !== null) parts.push(`${stars} stars`);
  if (language) parts.push(`language ${language}`);
  return {
    normalized,
    identityMatch,
    capability: GITHUB_REPO_EVIDENCE_CAPABILITY,
    summary: parts.join("; "),
  };
}

/** Canonical testnet terms for the remote buyer (single source for guards). */
export function testnetTerms(): { network: string; asset: string } {
  return { network: ARC_TESTNET_CAIP2, asset: ARC_TESTNET_USDC };
}
