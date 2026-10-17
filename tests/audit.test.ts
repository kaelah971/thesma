import { describe, expect, it } from "vitest";
import { hashSessionToken, newSessionToken } from "@/server/auth/session";
import { buildAuditEvent } from "@/server/services/audit";

describe("sessions + audit primitive", () => {
  it("issues unique opaque tokens with stable sha256 hashes (raw token never stored)", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(hashSessionToken(a)).toBe(hashSessionToken(a));
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
    expect(hashSessionToken(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds append-only audit events for S0 mutations", () => {
    const created = buildAuditEvent({
      id: "evt-1",
      actorType: "USER",
      actorId: "user-1",
      workspaceId: "ws-1",
      action: "workspace.created",
      targetType: "workspace",
      targetId: "ws-1",
      metadata: { name: "Acme" },
    });
    expect(created.action).toBe("workspace.created");
    expect(created.actorId).toBe("user-1");
    expect(created.metadata).toEqual({ name: "Acme" });

    const partnerEvt = buildAuditEvent({
      id: "evt-2",
      actorType: "USER",
      actorId: "user-9",
      partnerId: "p-9",
      action: "partner.updated",
      targetType: "partner",
      targetId: "p-9",
    });
    expect(partnerEvt.partnerId).toBe("p-9");
    expect(partnerEvt.workspaceId).toBeNull();
  });
});
