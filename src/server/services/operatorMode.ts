import { and, desc, eq } from "drizzle-orm";
import { isDbConfigured, getDb } from "../db/client";
import { auditEvents } from "../db/schema";
import type { AuditSink } from "./campaignStore";

/** Organization-level execution posture. Existing authority remains autonomous; shadow removes execution authority. */
export type OrganizationOperatorMode = "AUTONOMOUS" | "SHADOW";

export const OPERATOR_MODE_CHANGED_ACTION = "operator.mode.changed";

export type ShadowBlockedOperation =
  | "PAYMENT"
  | "X402_PURCHASE"
  | "CAPITAL_MOVEMENT"
  | "CREATOR_INVITE"
  | "SETTLEMENT";

export interface OperatorModeAuditRow {
  id?: string;
  metadata: unknown;
  createdAt?: Date | string | null;
}

/** Pure latest-valid-mode reducer used by the DB reader and unit tests. */
export function operatorModeFromAuditRows(rows: readonly OperatorModeAuditRow[]): OrganizationOperatorMode {
  let mode: OrganizationOperatorMode = "AUTONOMOUS";
  let latestAt = "";
  for (const row of rows) {
    const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
    const candidate = metadata.mode;
    if (candidate !== "AUTONOMOUS" && candidate !== "SHADOW") continue;
    const at = row.createdAt ? new Date(row.createdAt).toISOString() : "";
    const key = `${at}|${row.id ?? ""}`;
    if (key >= latestAt) {
      mode = candidate;
      latestAt = key;
    }
  }
  return mode;
}

/** Read the append-only organization mode. An unconfigured database has no mode row and stays on existing behavior. */
export async function getOrganizationOperatorMode(workspaceId: string): Promise<OrganizationOperatorMode> {
  if (!isDbConfigured()) return "AUTONOMOUS";
  try {
    const rows = await getDb()
      .select({ id: auditEvents.id, metadata: auditEvents.metadata, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, OPERATOR_MODE_CHANGED_ACTION)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(50);
    return operatorModeFromAuditRows(rows);
  } catch (err) {
    // Older deployments may not have the audit table during a build/health check.
    // Do not turn that compatibility case into a new execution behavior.
    if (/relation .* does not exist/i.test(err instanceof Error ? err.message : String(err ?? ""))) return "AUTONOMOUS";
    throw err;
  }
}

/** Append-only mode change. The mode itself is not mutable in place. */
export async function recordOrganizationOperatorMode(
  audit: AuditSink,
  params: { workspaceId: string; mode: OrganizationOperatorMode; actorId: string },
): Promise<void> {
  await audit({
    actorType: "USER",
    actorId: params.actorId,
    workspaceId: params.workspaceId,
    action: OPERATOR_MODE_CHANGED_ACTION,
    targetType: "workspace",
    targetId: params.workspaceId,
    metadata: {
      mode: params.mode,
      shadowExecutionBoundary: params.mode === "SHADOW",
      changedByUserId: params.actorId,
    },
  });
}

export function isShadowMode(mode: OrganizationOperatorMode): boolean {
  return mode === "SHADOW";
}

/** One shared fail-closed boundary for all operator side effects. */
export function assertExecutionAllowed(mode: OrganizationOperatorMode, operation: ShadowBlockedOperation): void {
  if (mode !== "SHADOW") return;
  throw Object.assign(new Error(`Shadow mode blocks ${operation.toLowerCase().replaceAll("_", " ")}.`), {
    status: 409,
    code: "SHADOW_EXECUTION_BLOCKED",
    details: { mode, operation },
  });
}

export function shadowBoundary(mode: OrganizationOperatorMode, operation: ShadowBlockedOperation): {
  mode: OrganizationOperatorMode;
  operation: ShadowBlockedOperation;
  executionAllowed: boolean;
  status: "NOT_EXECUTED" | "AVAILABLE";
} {
  return {
    mode,
    operation,
    executionAllowed: mode !== "SHADOW",
    status: mode === "SHADOW" ? "NOT_EXECUTED" : "AVAILABLE",
  };
}
