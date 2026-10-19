import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { userPersonas } from "../db/schema";

/**
 * Role-gateway persona service.
 *
 * A persona is product/entry state (which onboarding + home to show). It is
 * never consulted by auth guards: workspace/partner authorization still comes
 * only from workspace_members + ownership checks. Treating the persona cookie
 * or row as permission would be a bypass — so every resolver below only picks
 * UI destinations, and every data read stays membership-scoped.
 */

export const PERSONAS = ["customer", "creator", "organization", "developer"] as const;
export type Persona = (typeof PERSONAS)[number];

/** Pre-auth persona choice. HttpOnly, Lax, 1 year — survives the auth redirect. */
export const PERSONA_COOKIE = "thesma_persona";
export const PERSONA_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Lowercase slugs used in cookies/URLs. DB enum is the UPPER_SNAKE twin. */
export function parsePersona(value: unknown): Persona | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (PERSONAS as readonly string[]).includes(v) ? (v as Persona) : null;
}

export function personaToEnum(p: Persona): "CUSTOMER" | "CREATOR" | "ORGANIZATION" | "DEVELOPER" {
  return p.toUpperCase() as "CUSTOMER" | "CREATOR" | "ORGANIZATION" | "DEVELOPER";
}

export function personaFromEnum(value: unknown): Persona | null {
  return parsePersona(typeof value === "string" ? value.toLowerCase() : value);
}

/** Role home. Organization keeps the existing /app workspace product. */
export function personaHome(p: Persona): "/customer" | "/creator" | "/app" | "/build" {
  switch (p) {
    case "customer":
      return "/customer";
    case "creator":
      return "/creator";
    case "developer":
      return "/build";
    case "organization":
      return "/app";
  }
}

export function onboardingPath(p: Persona): string {
  return `/onboarding/${p}`;
}

/** Route params arrive URL-encoded ("%40bgirl"); decode before matching.
 * Keeps raw input on malformed sequences — normalizeHandle still rejects. */
export function decodeHandleParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Public creator handle: 3–30 chars, lowercase alphanumerics + underscore. */
const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const h = value.trim().toLowerCase().replace(/^@/, "");
  if (!h) return null;
  return HANDLE_RE.test(h) ? h : null;
}

export function isHandleValid(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return true; // optional field
  return normalizeHandle(value) !== null;
}

/**
 * True when the table is missing (migration not yet applied) — not a data error.
 *
 * Drizzle wraps driver failures as `Failed query: ...` with the Postgres
 * error on `cause`, so walk the chain: checking only the outer error
 * misses code 42P01 and turns a missing table into a 500 (this crashed
 * production /welcome + /start before migration 0009 was applied).
 *
 * Exported for unit tests; callers should keep using the safe readers.
 */
export function isMissingTable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur !== null && (typeof cur === "object" || typeof cur === "string") && !seen.has(cur); i++) {
    seen.add(cur);
    const code = typeof cur === "object" ? (cur as { code?: unknown }).code : undefined;
    const msg = cur instanceof Error ? cur.message : String(cur ?? "");
    if (code === "42P01" || /relation .* does not exist/i.test(msg)) return true;
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Safe read: returns null when there is no row OR the table is not migrated yet. */
export async function getPersonaByUserId(userId: string) {
  try {
    const db = getDb();
    const [row] = await db.select().from(userPersonas).where(eq(userPersonas.userId, userId)).limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export interface PersonaUpsert {
  persona: Persona;
  handle?: string | null;
  bio?: string | null;
  category?: string | null;
  project?: string | null;
  creatorType?: string | null;
  interests?: string | string[] | null;
  preferences?: string | string[] | null;
  complete?: boolean;
}

export const CREATOR_TYPES = ["CREATOR", "KOL", "DEVELOPER"] as const;
export type CreatorType = (typeof CREATOR_TYPES)[number];

/** Creator-controlled type. Unknown/missing stays null (generic) — never a 500. */
export function normalizeCreatorType(value: unknown): CreatorType | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toUpperCase();
  return (CREATOR_TYPES as readonly string[]).includes(s) ? (s as CreatorType) : null;
}

function normalizeTagList(value: unknown, allowed: readonly string[] | null, max: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (!s || out.includes(s)) continue;
    if (allowed && !allowed.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Free-form interest tags (max 20). Unknown tokens are dropped, never fatal. */
export function normalizeInterests(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return normalizeTagList(value, null, 20);
}

/** Campaign-type preferences from a fixed vocabulary; anything else is dropped. */
export const CAMPAIGN_PREFERENCES = [
  "referral",
  "purchase",
  "signup",
  "developer-adoption",
  "product-testing",
  "retention",
  "content-community",
] as const;

export function normalizePreferences(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return normalizeTagList(value, CAMPAIGN_PREFERENCES, CAMPAIGN_PREFERENCES.length);
}

/** Insert-or-update the caller's own persona row. Throws 409 on handle conflict. */
export async function upsertPersona(userId: string, input: PersonaUpsert) {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    throw err;
  }
  const now = new Date();
  const clean = {
    handle: input.handle === undefined ? undefined : input.handle?.trim() ? input.handle.trim().toLowerCase().replace(/^@/, "") : null,
    bio: input.bio === undefined ? undefined : input.bio?.trim() ? input.bio.trim().slice(0, 500) : null,
    category: input.category === undefined ? undefined : input.category?.trim() ? input.category.trim().slice(0, 100) : null,
    project: input.project === undefined ? undefined : input.project?.trim() ? input.project.trim().slice(0, 500) : null,
    creatorType: input.creatorType === undefined ? undefined : normalizeCreatorType(input.creatorType),
    interests: input.interests === undefined ? undefined : normalizeInterests(input.interests),
    preferences: input.preferences === undefined ? undefined : normalizePreferences(input.preferences),
  };
  if (clean.handle && !HANDLE_RE.test(clean.handle)) {
    throw Object.assign(new Error("Handle must be 3–30 lowercase letters, numbers or underscores."), {
      status: 400,
      code: "BAD_REQUEST",
    });
  }
  try {
    const existing = await getPersonaByUserId(userId);
    if (!existing) {
      const [row] = await db
        .insert(userPersonas)
        .values({
          userId,
          persona: personaToEnum(input.persona),
          handle: clean.handle ?? null,
          bio: clean.bio ?? null,
          category: clean.category ?? null,
          project: clean.project ?? null,
          creatorType: clean.creatorType ?? null,
          interests: clean.interests ?? [],
          preferences: clean.preferences ?? [],
          onboardingCompletedAt: input.complete ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row;
    }
    const [row] = await db
      .update(userPersonas)
      .set({
        persona: personaToEnum(input.persona),
        ...(clean.handle !== undefined ? { handle: clean.handle } : {}),
        ...(clean.bio !== undefined ? { bio: clean.bio } : {}),
        ...(clean.category !== undefined ? { category: clean.category } : {}),
        ...(clean.project !== undefined ? { project: clean.project } : {}),
        ...(clean.creatorType !== undefined ? { creatorType: clean.creatorType } : {}),
        ...(clean.interests !== undefined ? { interests: clean.interests } : {}),
        ...(clean.preferences !== undefined ? { preferences: clean.preferences } : {}),
        ...(input.complete ? { onboardingCompletedAt: existing.onboardingCompletedAt ?? now } : {}),
        updatedAt: now,
      })
      .where(eq(userPersonas.userId, userId))
      .returning();
    return row;
  } catch (err) {
    if (isMissingTable(err)) {
      throw Object.assign(new Error("Onboarding is temporarily unavailable. Try again shortly."), {
        status: 503,
        code: "UNAVAILABLE",
      });
    }
    const msg = err instanceof Error ? err.message : "";
    if (/unique|duplicate/i.test(msg) && /handle/i.test(msg)) {
      throw Object.assign(new Error("That handle is already taken."), { status: 409, code: "CONFLICT" });
    }
    throw err;
  }
}

export function serializePersonaCookie(persona: Persona, secure: boolean): string {
  const parts = [
    `${PERSONA_COOKIE}=${persona}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PERSONA_COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
