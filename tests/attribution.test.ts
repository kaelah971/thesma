import { describe, expect, it } from "vitest";
import {
  attributionSecretFromEnv,
  signAttribution,
  verifyAttribution,
} from "@/server/attribution/tokens";

const SECRET = "test-attribution-secret-32-chars!!";
const PAYLOAD = { referralId: "r-1", campaignId: "c-1", partnerId: "p-1", exp: 2_000_000_000_000 };
const NOW = 1_000_000_000_000;

describe("signed attribution tokens (no customer PII)", () => {
  it("signs and verifies a roundtrip with only referral-scoped fields", async () => {
    const token = signAttribution(PAYLOAD, SECRET);
    const r = verifyAttribution(token, SECRET, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.referralId).toBe("r-1");
      expect(r.payload.campaignId).toBe("c-1");
      expect(r.payload.partnerId).toBe("p-1");
      expect(Object.keys(r.payload).sort()).toEqual(["campaignId", "exp", "nonce", "partnerId", "referralId", "v"]);
    }
  });

  it("fails on tampered payloads, wrong secrets, and malformed tokens", async () => {
    const token = signAttribution(PAYLOAD, SECRET);
    const [, body, sig] = token.split(".");
    const tampered = `v1.${body.slice(0, -2)}AA.${sig}`;
    expect(verifyAttribution(tampered, SECRET, NOW).ok).toBe(false);
    expect(verifyAttribution(token, `${SECRET}-wrong-padded-to-32!!`, NOW).ok).toBe(false);
    expect(verifyAttribution("garbage", SECRET, NOW)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyAttribution("v1.a.b.c", SECRET, NOW)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("expires tokens and enforces a minimum secret length", async () => {
    const token = signAttribution(PAYLOAD, SECRET);
    expect(verifyAttribution(token, SECRET, PAYLOAD.exp)).toEqual({ ok: false, reason: "EXPIRED" });
    expect(verifyAttribution(token, SECRET, PAYLOAD.exp + 1)).toEqual({ ok: false, reason: "EXPIRED" });
    const withSecret = (v: Record<string, string>): NodeJS.ProcessEnv => v as unknown as NodeJS.ProcessEnv;
    expect(() => attributionSecretFromEnv(withSecret({ ATTRIBUTION_SECRET: "short" }))).toThrow();
    expect(attributionSecretFromEnv(withSecret({ ATTRIBUTION_SECRET: SECRET }))).toBe(SECRET);
    expect(() => attributionSecretFromEnv(withSecret({}))).toThrow();
  });

  it("mints unique nonces per signature", async () => {
    expect(signAttribution(PAYLOAD, SECRET)).not.toBe(signAttribution(PAYLOAD, SECRET));
  });
});
