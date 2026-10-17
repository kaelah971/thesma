import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { workspaceMembers, workspaces } from "../db/schema";
import { newId } from "../auth/session";
import { recordAuditEvent } from "./audit";

/**
 * Workspace service. Transactional boundary for S0: creating a workspace
 * always creates the OWNER membership + audit event together.
 */
export async function createWorkspaceWithOwner(params: {
  userId: string;
  name: string;
  category?: string | null;
}) {
  const db = getDb();
  const workspaceId = newId();
  const now = new Date();
  const name = params.name.trim();
  if (!name) throw Object.assign(new Error("Workspace name is required"), { status: 400 });

  const [workspace] = await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      ownerUserId: params.userId,
      name,
      category: params.category ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db.insert(workspaceMembers).values({
    id: newId(),
    workspaceId,
    userId: params.userId,
    role: "ORGANIZATION_OWNER",
  });

  await recordAuditEvent(db, {
    actorType: "USER",
    actorId: params.userId,
    workspaceId,
    action: "workspace.created",
    targetType: "workspace",
    targetId: workspaceId,
    metadata: { name },
  });

  return workspace;
}

export async function getWorkspaceById(workspaceId: string) {
  const db = getDb();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ?? null;
}

export async function listUserWorkspaces(userId: string) {
  const db = getDb();
  return db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
}
