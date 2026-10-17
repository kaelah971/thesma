import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed first-party attribution tokens (S3).
 *
 * A referral click mints `v1.<payload>.<sig>` where payload carries ONLY
 * referralId, campaignId, partnerId, expiry and a nonce — no customer
 * name/email/phone anywhere. S4 consumes this token at checkout.
 *
 * Signing: HMAC-SHA256 over the base64url payload with ATTRIBUTION_SECRET.
 * The secret never leaves the server and is never logged.
 */

export const ATTRIBUTION_COOKIE_NAME = "thesma_attr";
export const ATTRIBUTION_MIN_SECRET_LENGTH = 32;

export interface AttributionPayload {
  v: 1;
  referralId: string;
  campaignId: string;
  partnerId: string;
  /** Unix milliseconds. */
  exp: number;
  nonce: string;
}

export function attributionSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ATTRIBUTION_SECRET ?? "";
  if (secret.length < ATTRIBUTION_MIN_SECRET_LENGTH) {
    throw Object.assign(
      new Error(`ATTRIBUTION_SECRET must be at least ${ATTRIBUTION_MIN_SECRET_LENGTH} characters`),
      { status: 503, code: "ATTRIBUTION_UNCONFIGURED" },
    );
  }
  return secret;
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signAttribution(
  payload: Omit<AttributionPayload, "v" | "nonce"> & { nonce?: string },
  secret: string,
): string {
  const body: AttributionPayload = {
    v: 1,
    referralId: payload.referralId,
    campaignId: payload.campaignId,
    partnerId: payload.partnerId,
    exp: payload.exp,
    nonce: payload.nonce ?? randomBytes(12).toString("base64url"),
  };
  const encoded = b64urlEncode(JSON.stringify(body));
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `v1.${encoded}.${sig}`;
}

export function verifyAttribution(
  token: string,
  secret: string,
  nowMs: number,
): { ok: true; payload: AttributionPayload } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" } {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    return { ok: false, reason: "MALFORMED" };
  }
  const expected = createHmac("sha256", secret).update(parts[1]).digest("base64url");
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let payload: AttributionPayload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1])) as AttributionPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.referralId !== "string" ||
    typeof payload.campaignId !== "string" ||
    typeof payload.partnerId !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.nonce !== "string"
  ) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (payload.exp <= nowMs) return { ok: false, reason: "EXPIRED" };
  return { ok: true, payload };
}
