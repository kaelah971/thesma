import type { PublicProgramConfig } from "./browser";

export class ThesmaApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(params: { code: string; message: string; status: number; details?: unknown }) {
    super(params.message);
    this.name = "ThesmaApiError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }
}

export interface ServerOutcomeEvent {
  event: Record<string, unknown>;
  receipt: Record<string, unknown>;
  eventId: string;
  receiptId: string;
  programId: string | null;
  attributionStatus: string;
  verificationState: string;
  operatorMode: string;
  executionState: string;
  idempotent?: boolean;
  mode?: string;
}

export interface SubmitOutcomeEventInput {
  program: string;
  outcome?: string;
  externalEventId: string;
  externalSubjectId: string;
  attributionId?: string;
  occurredAt: string | Date;
  evidence: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ThesmaServerClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

function safeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Thesma server client baseUrl must be an absolute HTTP(S) URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Thesma server client baseUrl must use HTTP(S).");
  return url.toString().replace(/\/$/, "");
}

function safeApiKey(value: string): string {
  if (typeof value !== "string" || !/^ths_api_[A-Za-z0-9_-]+$/.test(value)) throw new Error("Thesma server client apiKey must be a ths_api_ key.");
  return value;
}

function safeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ThesmaApiError({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "An explicit idempotencyKey is required for outcome submission.", status: 400 });
  return value;
}

async function bodyOf(response: Response): Promise<Record<string, unknown> | null> {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

export function createThesmaServerClient(options: ThesmaServerClientOptions) {
  const baseUrl = safeBaseUrl(options.baseUrl);
  const apiKey = safeApiKey(options.apiKey);
  const fetchImpl = options.fetch ?? fetch;

  async function request(path: string, init: RequestInit = {}, auth = true): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (auth) headers.set("authorization", `Bearer ${apiKey}`);
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    const data = await bodyOf(response);
    if (!response.ok) {
      const error = data?.error as { code?: string; message?: string; details?: unknown } | undefined;
      throw new ThesmaApiError({ code: error?.code ?? "THESMA_REQUEST_FAILED", message: error?.message ?? "Thesma request failed.", status: response.status, details: error?.details });
    }
    return data ?? {};
  }

  async function getProgram(program: string): Promise<PublicProgramConfig> {
    const data = await request(`/api/v1/public/programs/${encodeURIComponent(program)}`, {}, false);
    return data.program as PublicProgramConfig;
  }

  async function submitOutcomeEvent(input: SubmitOutcomeEventInput): Promise<ServerOutcomeEvent> {
    const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
    const program = await getProgram(input.program);
    const outcome = input.outcome ?? (program as PublicProgramConfig & { outcomeSlug?: string }).outcomeSlug;
    if (!outcome) throw new ThesmaApiError({ code: "OUTCOME_NOT_FOUND", message: "The public program did not provide an outcome slug.", status: 500 });
    const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
    const body = {
      growthProgramId: program.id,
      attributionId: input.attributionId,
      externalEventId: input.externalEventId,
      externalSubjectId: input.externalSubjectId,
      occurredAt,
      evidence: input.evidence,
    };
    const result = await request(`/api/v1/outcomes/${encodeURIComponent(outcome)}/events`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
    const event = (result.event ?? {}) as Record<string, unknown>;
    const receipt = (result.receipt ?? {}) as Record<string, unknown>;
    const evaluation = (receipt.programEvaluation ?? {}) as Record<string, unknown>;
    const operatorDecision = (evaluation.operatorDecision ?? {}) as Record<string, unknown>;
    const execution = (evaluation.execution ?? {}) as Record<string, unknown>;
    return {
      ...result,
      event,
      receipt,
      eventId: typeof event.id === "string" ? event.id : "",
      receiptId: typeof receipt.id === "string" ? receipt.id : "",
      programId: typeof event.growthProgramId === "string" ? event.growthProgramId : null,
      attributionStatus: typeof event.attributionStatus === "string" ? event.attributionStatus : "UNATTRIBUTED",
      verificationState: typeof event.verificationState === "string" ? event.verificationState : "SUBMITTED",
      operatorMode: typeof operatorDecision.mode === "string" ? operatorDecision.mode : typeof result.mode === "string" ? result.mode : "SHADOW",
      executionState: typeof execution.status === "string" ? execution.status : typeof event.executionState === "string" ? event.executionState : "NOT_EXECUTED",
    } as ServerOutcomeEvent;
  }

  async function getOutcomeEvent(eventId: string): Promise<Record<string, unknown>> {
    return request(`/api/v1/outcomes/events/${encodeURIComponent(eventId)}`);
  }

  async function getReceipt(eventId: string): Promise<Record<string, unknown>> {
    const status = await getOutcomeEvent(eventId);
    return status.receipt as Record<string, unknown>;
  }

  return { getProgram, submitOutcomeEvent, getOutcomeEvent, getReceipt, baseUrl };
}
