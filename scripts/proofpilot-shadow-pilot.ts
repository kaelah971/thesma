import { createThesmaServerClient } from "../src/sdk/server";

const baseUrl = (process.env.THESMA_BASE_URL ?? "https://thesma.vercel.app").replace(/\/$/, "");
const programSlug = process.env.THESMA_PROGRAM_SLUG ?? "proofpilot-partner-growth";
const apiKey = process.env.THESMA_API_KEY;
const attributionCode = process.env.THESMA_ATTRIBUTION_CODE;
const confirmation = process.env.THESMA_PROOF_CONFIRM;
const externalEventId = process.env.THESMA_EXTERNAL_EVENT_ID ?? "proofpilot_shadow_pilot_001";
const externalSubjectId = process.env.THESMA_EXTERNAL_SUBJECT_ID ?? "proofpilot_test_user_001";
const occurredAt = process.env.THESMA_PILOT_OCCURRED_AT ?? "2026-11-02T20:00:00.000Z";

function fail(message: string): never {
  throw new Error(message);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

async function resolveAttribution(): Promise<{ attributionId: string; status: string }> {
  if (!attributionCode) fail("THESMA_ATTRIBUTION_CODE is required; no attribution identity will be guessed.");
  const response = await fetch(`${baseUrl}/api/v1/public/programs/${encodeURIComponent(programSlug)}/attribution/${encodeURIComponent(attributionCode)}`, { headers: { accept: "application/json" } });
  const payload = await json(response);
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    fail(`Attribution resolution failed: ${String(error.code ?? response.status)} — ${String(error.message ?? "request failed")}`);
  }
  const attribution = (payload.attribution ?? {}) as Record<string, unknown>;
  if (typeof attribution.attributionId !== "string") fail("Attribution response did not contain a usable attribution identity.");
  return {
    attributionId: attribution.attributionId,
    status: typeof attribution.status === "string" ? attribution.status : "UNKNOWN",
  };
}

async function main() {
  if (confirmation !== "PROOFPILOT_SHADOW_001") fail("Set THESMA_PROOF_CONFIRM=PROOFPILOT_SHADOW_001 to create the explicitly-labelled production pilot event.");
  if (!apiKey) fail("THESMA_API_KEY is required and is never printed or written to a report.");

  const attribution = await resolveAttribution();
  const client = createThesmaServerClient({ baseUrl, apiKey });
  const evidence = {
    userId: externalSubjectId,
    accountCreatedAt: "2026-11-02T19:00:00.000Z",
    onboardingCompletedAt: "2026-11-02T19:20:00.000Z",
    firstMeaningfulActionAt: "2026-11-02T19:45:00.000Z",
  };
  const input = {
    program: programSlug,
    externalEventId,
    externalSubjectId,
    attributionId: attribution.attributionId,
    occurredAt,
    evidence,
    idempotencyKey: `proofpilot:shadow:${externalEventId}`,
  };

  const first = await client.submitOutcomeEvent(input);
  const retry = await client.submitOutcomeEvent(input);
  const receipt = await client.getReceipt(first.eventId);
  const evaluation = (receipt.programEvaluation ?? {}) as Record<string, unknown>;
  const reward = (evaluation.reward ?? {}) as Record<string, unknown>;
  const operator = (evaluation.operatorDecision ?? {}) as Record<string, unknown>;
  const execution = (evaluation.execution ?? {}) as Record<string, unknown>;

  console.log(JSON.stringify({
    environment: "production-software / shadow-financial-mode",
    programSlug,
    eventId: first.eventId,
    receiptId: first.receiptId,
    attribution: attribution.status,
    verification: first.verificationState,
    procurement: (evaluation.verificationProcurement as Record<string, unknown> | undefined)?.decision ?? "UNKNOWN",
    rewardEligibility: reward.eligibility ?? "UNKNOWN",
    operator: operator.recommendation ?? "UNKNOWN",
    operatorMode: first.operatorMode,
    execution: execution.status ?? first.executionState,
    paidMicroUsdc: execution.actualPaidMicroUsdc ?? "0",
    idempotentRetry: retry.eventId === first.eventId && retry.receiptId === first.receiptId,
    financialTransaction: execution.financialTransaction ?? null,
    circleCalls: execution.circleCalls ?? 0,
    x402PaidCalls: execution.x402PaidCalls ?? 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Proof pilot failed.");
  process.exitCode = 1;
});
