import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? "thesma_session";

/** 30-day opaque sessions. Token is never stored; only its sha256 hash is. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newId(): string {
  return randomUUID();
}

export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS);
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
