import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "./errors";

const MIN_SECRET_LENGTH = 16;

/**
 * Server-only gate for reconciliation triggers. No facts accepted from callers.
 * Accepts any one of the named env secrets (all server-only, length-checked).
 */
export function requireInternalSecret(req: Request, names: string[] = ["VERIFIER_INTERNAL_SECRET"]) {
  const candidates = names
    .map((n) => process.env[n] ?? "")
    .filter((s) => s.length >= MIN_SECRET_LENGTH);
  if (candidates.length === 0) {
    return errorResponse("UNCONFIGURED", "Internal worker secret is not configured", 503);
  }
  const header = req.headers.get("authorization") ?? "";
  const got = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  for (const expected of candidates) {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return null;
  }
  return errorResponse("UNAUTHORIZED", "Invalid internal secret", 401);
}
