import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "./errors";

const MIN_SECRET_LENGTH = 16;

/** Server-only gate for reconciliation triggers. No facts accepted from callers. */
export function requireInternalSecret(req: Request) {
  const expected = process.env.VERIFIER_INTERNAL_SECRET ?? "";
  if (expected.length < MIN_SECRET_LENGTH) {
    return errorResponse("UNCONFIGURED", "Verifier internal secret is not configured", 503);
  }
  const header = req.headers.get("authorization") ?? "";
  const got = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorResponse("UNAUTHORIZED", "Invalid internal secret", 401);
  }
  return null;
}
