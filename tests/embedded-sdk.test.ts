import { describe, expect, it } from "vitest";
import { buildReferralUrl, createThesmaBrowserClient } from "@/sdk/browser";
import { createThesmaServerClient, ThesmaApiError } from "@/sdk/server";
import { toPublicGrowthProgram } from "@/server/services/publicGrowthPrograms";
import type { SafeGrowthProgram } from "@/server/services/growthPrograms";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const publicProgram: SafeGrowthProgram = {
  id: "program-proofpilot",
  projectId: "project-proofpilot",
  workspaceId: "project-proofpilot",
  campaignId: "campaign-proofpilot",
  policyVersionId: "policy-proofpilot",
  name: "ProofPilot Partner Growth",
  slug: "proofpilot-partner-growth",
  objectiveOutcomeType: "ACTIVATED_USER",
  targetOutcomeCount: 100,
  budgetMicroUsdc: "500000000",
  maxVerifiedCacMicroUsdc: "10000000",
  rewardStructure: "PERFORMANCE_ONLY",
  rewardCeilingMicroUsdc: "8000000",
  participantTypes: ["CREATORS", "REFERRAL_PARTNERS"],
  operatorMode: "SHADOW",
  status: "DRAFT",
  participationStatus: "OPEN",
  attributionStatus: "CONFIGURED",
  productUrl: "https://proofpilot.example",
  integrationReadiness: "CONNECTED",
  fundingStatus: "NOT_FUNDED",
  settlementStatus: "NOT_CONFIGURED",
  outcomeDefinition: {
    id: "definition-proofpilot",
    slug: "activated-user",
    name: "Activated user",
    outcomeType: "ACTIVATED_USER",
    unitValueMicroUsdc: "8000000",
    verificationPolicyId: "policy-activated-user",
    requiredEvidenceFields: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
    holdSeconds: 86400,
  },
  integration: { id: "integration-proofpilot", name: "ProofPilot", status: "ACTIVE", apiKeyPrefix: "ths_api_test…" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("embedded SDK", () => {
  it("captures, persists, reads and clears public attribution without an API key", async () => {
    const storage = new MemoryStorage();
    const calls: string[] = [];
    const client = createThesmaBrowserClient({
      baseUrl: "https://thesma.example",
      program: "proofpilot-partner-growth",
      storage,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ attribution: { status: "ATTRIBUTED", programId: "program-proofpilot", programSlug: "proofpilot-partner-growth", attributionId: "attr_123", capturedAt: "2026-01-15T12:00:00.000Z", participant: { displayName: "Creator Alpha", handle: "alpha" } } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const result = await client.captureAttribution({ url: "https://product.example/?utm_source=creator&ref=ref_abc" });
    expect(result.status).toBe("ATTRIBUTED");
    expect(client.getAttribution()?.attributionId).toBe("attr_123");
    expect(calls[0]).toContain("/api/v1/public/programs/proofpilot-partner-growth/attribution/ref_abc");
    client.clearAttribution();
    expect(client.getAttribution()).toBeNull();
  });

  it("refuses accidental secret options and invalid referral destinations", () => {
    expect(() => createThesmaBrowserClient({ baseUrl: "https://thesma.example", program: "proofpilot-partner-growth", apiKey: "ths_api_secret" } as never)).toThrow(/server-only/);
    expect(() => buildReferralUrl({ destination: "javascript:alert(1)", referralCode: "ref_abc" })).toThrow(/HTTP/);
    expect(() => buildReferralUrl({ destination: "https://product.example/path?utm=one", referralCode: "ref_abc" })).not.toThrow();
    expect(buildReferralUrl({ destination: "https://product.example/path?utm=one", referralCode: "ref_abc" })).toContain("utm=one");
    expect(buildReferralUrl({ destination: "https://product.example/path?utm=one", referralCode: "ref_abc" })).toContain("ref=ref_abc");
  });

  it("returns a bounded refusal for invalid or revoked attribution", async () => {
    const client = createThesmaBrowserClient({
      baseUrl: "https://thesma.example",
      program: "proofpilot-partner-growth",
      storage: new MemoryStorage(),
      fetch: async () => new Response(JSON.stringify({ error: { code: "ATTRIBUTION_REVOKED", message: "Attribution identity has been revoked." } }), { status: 409, headers: { "content-type": "application/json" } }),
    });
    const result = await client.captureAttribution({ url: "https://product.example/?ref=ref_revoked" });
    expect(result).toMatchObject({ status: "REFUSED", programSlug: "proofpilot-partner-growth" });
  });

  it("requires a server API key", () => {
    expect(() => createThesmaServerClient({ baseUrl: "https://thesma.example", apiKey: "" })).toThrow(/ths_api_/);
  });

  it("keeps server authentication, attribution and idempotency on the server side", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createThesmaServerClient({
      baseUrl: "https://thesma.example",
      apiKey: "ths_api_server_test",
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        if (String(input).includes("/public/programs/")) return new Response(JSON.stringify({ program: { id: "program-proofpilot", slug: "proofpilot-partner-growth", outcomeSlug: "activated-user" } }), { status: 200 });
        if (String(input).includes("/events") && init.method === "POST") return new Response(JSON.stringify({ event: { id: "event_1", attributionStatus: "DIRECT_ATTRIBUTION" }, receipt: { id: "receipt_1" }, mode: "SHADOW" }), { status: 201 });
        return new Response(JSON.stringify({ event: { id: "event_1" }, receipt: { id: "receipt_1" } }), { status: 200 });
      },
    });
    const result = await client.submitOutcomeEvent({ program: "proofpilot-partner-growth", externalEventId: "activation_001", externalSubjectId: "user_123", attributionId: "attr_123", occurredAt: new Date("2026-01-15T12:00:00.000Z"), evidence: { userId: "user_123" }, idempotencyKey: "proofpilot:activation_001" });
    expect(result.event).toMatchObject({ id: "event_1", attributionStatus: "DIRECT_ATTRIBUTION" });
    const outcomeCall = calls.find((call) => call.init.method === "POST")!;
    const outcomeHeaders = new Headers(outcomeCall.init.headers);
    expect(outcomeHeaders.get("authorization")).toBe("Bearer ths_api_server_test");
    expect(outcomeHeaders.get("idempotency-key")).toBe("proofpilot:activation_001");
    expect(JSON.parse(String(outcomeCall.init.body))).toMatchObject({ growthProgramId: "program-proofpilot", attributionId: "attr_123" });
    await expect(client.submitOutcomeEvent({ program: "proofpilot-partner-growth", externalEventId: "activation_002", externalSubjectId: "user_123", occurredAt: new Date(), evidence: {}, idempotencyKey: "" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(client.getReceipt("event_1")).resolves.toMatchObject({ id: "receipt_1" });
  });

  it("preserves deterministic API errors", async () => {
    const client = createThesmaServerClient({ baseUrl: "https://thesma.example", apiKey: "ths_api_server_test", fetch: async () => new Response(JSON.stringify({ error: { code: "ATTRIBUTION_CONFLICT", message: "already attributed" } }), { status: 409 }) });
    await expect(client.getOutcomeEvent("event_1")).rejects.toBeInstanceOf(ThesmaApiError);
    await expect(client.getOutcomeEvent("event_1")).rejects.toMatchObject({ code: "ATTRIBUTION_CONFLICT", status: 409 });
  });

  it("exposes only bounded public program information", () => {
    const publicView = toPublicGrowthProgram(publicProgram, "https://thesma.example");
    expect(publicView).toMatchObject({ id: "program-proofpilot", slug: "proofpilot-partner-growth", outcomeSlug: "activated-user", participationUrl: "https://thesma.example/g/proofpilot-partner-growth", joinable: true });
    expect(publicView).not.toHaveProperty("budgetMicroUsdc");
    expect(publicView).not.toHaveProperty("maxVerifiedCacMicroUsdc");
    expect(publicView).not.toHaveProperty("integration");
    expect(publicView).not.toHaveProperty("policyVersionId");
  });
});
