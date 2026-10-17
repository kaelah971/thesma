import type { Db } from "../db/client";
import { auditEvents } from "../db/schema";
import { newId } from "../auth/session";
import type { ActorType } from "../domain/types";

export interface AuditInput {
  actorType: ActorType;
  actorId?: string | null;
  workspaceId?: string | null;
  partnerId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit primitive. Insert-only by convention — no update/delete
 * helpers are exposed. NOT the later financial receipt system.
 */
export async function recordAuditEvent(db: Db, input: AuditInput) {
  const [row] = await db
    .insert(auditEvents)
    .values({
      id: newId(),
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      workspaceId: input.workspaceId ?? null,
      partnerId: input.partnerId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();
  return row;
}

/** Pure builder for unit tests — mirrors the insert shape without a DB. */
export function buildAuditEvent(input: AuditInput & { id: string }) {
  return {
    id: input.id,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    workspaceId: input.workspaceId ?? null,
    partnerId: input.partnerId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
    createdAt: new Date(0),
  };
}
