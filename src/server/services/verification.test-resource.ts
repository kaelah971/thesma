import { getAddress, isAddress, recoverMessageAddress, type Hex } from "viem";
import {
  ARC_MAINNET_CAIP2,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  X402_VERSION,
  type CheckType,
} from "./verification";

/**
 * Local x402 v2 test resource (TEST ONLY — Slice 8).
 *
 * Implements the CURRENT v2 HTTP behavior for integration tests:
 *   first request → 402 + PAYMENT-REQUIRED
 *   retry with valid PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE
 * with deterministic CHECK_CLEAR / RISK_SIGNAL / INCONCLUSIVE verdicts.
 *
 * HARD RULES:
 * - Throws on import-time use when NODE_ENV === "production" unless the
 *   explicit THESMA_ALLOW_TEST_PROVIDERS flag is set.
 * - Never presented as third-party traction. It proves client/protocol
 *   logic only; real-provider interop stays CONFIGURATION_REQUIRED.
 * - The handler is an in-process fetch stub (no ports, no network).
 */

export function assertTestResourceAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && env.THESMA_ALLOW_TEST_PROVIDERS !== "1") {
    throw Object.assign(new Error("Local test verification provider is unavailable in production."), {
      status: 503,
      code: "TEST_PROVIDER_UNAVAILABLE",
    });
  }
}

export interface LocalTestResourceOpts {
  verdict?: "clear" | "risk" | "inconclusive";
  costMicroUsdc?: bigint;
  asset?: string;
  network?: string;
  payTo?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_ASSET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEFAULT_PAY_TO = "0x000000000000000000000000000000000000dEaD";

export function createLocalTestResource(opts: LocalTestResourceOpts = {}): {
  providerId: "local-test";
  url: string;
  allowedHosts: string[];
  price: { costMicroUsdc: bigint; asset: string; network: string; payTo: string };
  handler: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const env = opts.env ?? process.env;
  assertTestResourceAllowed(env);
  const verdict = opts.verdict ?? "risk";
  const costMicroUsdc = opts.costMicroUsdc ?? 80_000n;
  const asset = opts.asset ?? DEFAULT_ASSET;
  const network = opts.network ?? ARC_MAINNET_CAIP2;
  const payTo = opts.payTo ?? DEFAULT_PAY_TO;
  const url = "http://localhost/x402-test/verify";

  const requiredTerms = {
    scheme: "exact",
    network,
    asset,
    amount: costMicroUsdc.toString(),
    payTo,
    maxTimeoutSeconds: 300,
  };
  const paymentRequired = () =>
    Buffer.from(JSON.stringify({ x402Version: X402_VERSION, resource: { url }, accepted: [requiredTerms] }), "utf8").toString("base64");

  const handler = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const sig = headers.get(PAYMENT_SIGNATURE_HEADER);
    if (!sig) {
      return new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { [PAYMENT_REQUIRED_HEADER]: paymentRequired(), "content-type": "application/json" },
      });
    }
    // Validate the envelope: exact terms echo + recoverable signer.
    let envelope: { x402Version?: number; signer?: string; signature?: string; terms?: typeof requiredTerms };
    try {
      envelope = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
    } catch {
      return new Response(JSON.stringify({ error: "malformed signature envelope" }), { status: 400 });
    }
    if (envelope.x402Version !== X402_VERSION) {
      return new Response(JSON.stringify({ error: "unsupported x402 version" }), { status: 400 });
    }
    const t = (envelope.terms ?? {}) as Record<string, unknown>;
    const termsOk =
      t.scheme === "exact" &&
      t.network === network &&
      String(t.asset).toLowerCase() === asset.toLowerCase() &&
      String(t.amount) === costMicroUsdc.toString() &&
      isAddress(String(t.payTo ?? "")) &&
      getAddress(String(t.payTo)) === getAddress(payTo);
    if (!termsOk || typeof envelope.signature !== "string" || !isAddress(String(envelope.signer ?? ""))) {
      return new Response(JSON.stringify({ error: "terms mismatch" }), { status: 402, headers: { [PAYMENT_REQUIRED_HEADER]: paymentRequired() } });
    }
    const canonical = JSON.stringify({
      x402Version: X402_VERSION, resource: url, scheme: "exact", network, asset, amount: costMicroUsdc.toString(), payTo,
    });
    let recovered: string | null = null;
    try {
      recovered = await recoverMessageAddress({ message: canonical, signature: envelope.signature as Hex });
    } catch {
      recovered = null;
    }
    if (!recovered || recovered.toLowerCase() !== String(envelope.signer).toLowerCase()) {
      return new Response(JSON.stringify({ error: "bad signature" }), { status: 402, headers: { [PAYMENT_REQUIRED_HEADER]: paymentRequired() } });
    }
    const body = {
      verdict,
      confidence: verdict === "clear" ? "high" : "medium",
      reasonCodes: verdict === "risk" ? ["TEST_RISK_PATTERN"] : ["TEST_BASELINE"],
      evidenceRefs: ["test-evidence-1"],
    };
    const paymentResponse = Buffer.from(
      JSON.stringify({ paymentReference: `test-pay-${Date.now().toString(36)}`, network, scheme: "exact", amount: costMicroUsdc.toString() }),
      "utf8",
    ).toString("base64");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { [PAYMENT_RESPONSE_HEADER]: paymentResponse, "content-type": "application/json" },
    });
  };

  return {
    providerId: "local-test",
    url,
    allowedHosts: ["localhost", "127.0.0.1"],
    price: { costMicroUsdc, asset, network, payTo },
    handler,
  };
}

/** Check types the local resource can answer (mapping is test-local, not a real capability claim). */
export const LOCAL_TEST_CHECK_TYPES: CheckType[] = [
  "TRANSACTION_RISK",
  "ATTRIBUTION_INTEGRITY",
  "SUBJECT_DUPLICATION",
  "PAYMENT_REFERENCE_CHECK",
  "OUTCOME_ENRICHMENT",
];
