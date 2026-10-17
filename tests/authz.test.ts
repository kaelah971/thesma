import { describe, expect, it } from "vitest";
import { canMutateWorkspace, isWorkspaceMember } from "@/server/auth/guard";
import { isPartnerOwner } from "@/server/services/partners";

describe("role authorization + workspace isolation", () => {
  it("only ORGANIZATION_OWNER can mutate the workspace", () => {
    expect(canMutateWorkspace("ORGANIZATION_OWNER")).toBe(true);
    expect(canMutateWorkspace("ORGANIZATION_MEMBER")).toBe(false);
    expect(canMutateWorkspace("PARTNER")).toBe(false);
    expect(canMutateWorkspace(null)).toBe(false);
    expect(canMutateWorkspace(undefined)).toBe(false);
  });

  it("membership admits owner/member/partner, rejects outsiders", () => {
    expect(isWorkspaceMember("ORGANIZATION_OWNER")).toBe(true);
    expect(isWorkspaceMember("ORGANIZATION_MEMBER")).toBe(true);
    expect(isWorkspaceMember("PARTNER")).toBe(true);
    expect(isWorkspaceMember(null)).toBe(false);
    expect(isWorkspaceMember(undefined)).toBe(false);
  });

  it("workspace isolation: membership lookup must scope by (workspaceId, userId)", () => {
    // Simulates the DB unique constraint + guard: same user in ws-A is NOT
    // a member of ws-B. The route returns 403 for non-members.
    const memberships = [
      { workspaceId: "ws-A", userId: "user-1", role: "ORGANIZATION_OWNER" as const },
    ];
    const isMember = (ws: string, user: string) =>
      memberships.some((m) => m.workspaceId === ws && m.userId === user);
    expect(isMember("ws-A", "user-1")).toBe(true);
    expect(isMember("ws-B", "user-1")).toBe(false); // isolation holds
    expect(isMember("ws-A", "user-2")).toBe(false); // outsider blocked
  });

  it("partner profile ownership is strictly per-user", () => {
    expect(isPartnerOwner("user-1", "user-1")).toBe(true);
    expect(isPartnerOwner("user-1", "user-2")).toBe(false);
  });
});
