import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNCONFIGURED"
  | "INTERNAL"
  | "INVALID_API_KEY"
  | "INTEGRATION_REVOKED"
  | "INTEGRATION_NOT_FOUND"
  | "OUTCOME_NOT_FOUND"
  | "OUTCOME_INACTIVE"
  | "EVENT_NOT_FOUND"
  | "INVALID_EVIDENCE"
  | "INVALID_SCHEMA"
  | "SCHEMA_VERSION_IMMUTABLE"
  | "SCHEMA_VERSION_MISMATCH"
  | "UNSUPPORTED_OUTCOME_TYPE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "REPLAY_DETECTED"
  | "SUBJECT_INVALID"
  | "INVALID_TIMESTAMP"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED";

export function errorResponse(code: ApiErrorCode, message: string, status: number, details?: unknown) {
  return Response.json({ error: { code, message, details } }, { status });
}

export function badRequest(message: string, details?: unknown) {
  return errorResponse("BAD_REQUEST", message, 400, details);
}

export function unauthorized(message = "Unauthorized") {
  return errorResponse("UNAUTHORIZED", message, 401);
}

export function forbidden(message = "Forbidden") {
  return errorResponse("FORBIDDEN", message, 403);
}

export function notFound(message = "Not found") {
  return errorResponse("NOT_FOUND", message, 404);
}

export function conflict(message: string) {
  return errorResponse("CONFLICT", message, 409);
}

export function unconfigured(message = "Database is not configured") {
  return errorResponse("UNCONFIGURED", message, 503);
}

/** Maps thrown guard errors ({status, code}) and Zod issues to typed responses. */
export function toApiError(err: unknown) {
  if (err !== null && typeof err === "object" && "status" in err) {
    const e = err as { status?: number; code?: string; message?: string; details?: unknown };
    const status = typeof e.status === "number" ? e.status : 500;
    const code = (e.code as ApiErrorCode | undefined) ?? "INTERNAL";
    return errorResponse(code, e.message ?? "Internal error", status, e.details);
  }
  return errorResponse("INTERNAL", "Internal error", 500);
}
