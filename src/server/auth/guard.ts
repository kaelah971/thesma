import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb, isDbConfigured } from "../db/client";
import { sessions, users, workspaceMembers } from "../db/schema";
import type { WorkspaceRole } from "../domain/enums";
import { SESSION_COOKIE_NAME, hashSessionToken } from "./session";

/**
 * Server-side authorization. Every workspace/partner route must go through
 * these helpers — never trust client-supplied userId/role.
 */

export interface AuthContext {
  userId: string;
  email: string;
  name: string | null;
}

export async function getSessionUser(): Promise<AuthContext | null> {
  if (!isDbConfigured()) return null;
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);
  if (!row) return null;
  return { userId: row.user.id, email: row.user.email, name: row.user.name };
}

export async function requireUser(): Promise<AuthContext> {
  const user = await getSessionUser();
  if (!user) {
    throw Object.assign(new Error("Unauthorized"), { status: 401, code: "UNAUTHORIZED" });
  }
  return user;
}

/** Returns the caller's membership or null (workspace isolation primitive). */
export async function getMembership(workspaceId: string, userId: string) {
  if (!isDbConfigured()) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function requireMembership(workspaceId: string, userId: string) {
  const m = await getMembership(workspaceId, userId);
  if (!m) {
    throw Object.assign(new Error("Forbidden: not a workspace member"), {
      status: 403,
      code: "FORBIDDEN",
    });
  }
  return m;
}

export async function requireOwner(workspaceId: string, userId: string) {
  const m = await requireMembership(workspaceId, userId);
  if (m.role !== "ORGANIZATION_OWNER") {
    throw Object.assign(new Error("Forbidden: owner only"), {
      status: 403,
      code: "FORBIDDEN",
    });
  }
  return m;
}

/** Pure, DB-free role check — unit-tested without Postgres. */
export function canMutateWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return role === "ORGANIZATION_OWNER";
}

export function isWorkspaceMember(role: WorkspaceRole | null | undefined): boolean {
  return role === "ORGANIZATION_OWNER" || role === "ORGANIZATION_MEMBER" || role === "PARTNER";
}
