import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/server/db/client", () => ({
  isDbConfigured: () => true,
  getDb: () => ({ update: () => ({ set: () => ({ where: async () => {} }) }) }),
}));
vi.mock("@/server/services/workspaces", () => ({ listUserWorkspaces: async () => [] }));
vi.mock("@/server/services/partners", () => ({
  getPartnerByUserId: vi.fn(),
  createPartnerProfile: vi.fn(),
}));
vi.mock("@/server/services/personas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/personas")>();
  return {
    ...actual,
    getPersonaByUserId: vi.fn(),
    upsertPersona: vi.fn(),
  };
});

import { getSessionUser } from "@/server/auth/guard";
import { getPartnerByUserId, createPartnerProfile } from "@/server/services/partners";
import { getPersonaByUserId, isHandleValid, normalizeHandle, upsertPersona } from "@/server/services/personas";
import { GET, PATCH, POST } from "@/app/api/persona/route";

const session = vi.mocked(getSessionUser);
const mockPersona = vi.mocked(getPersonaByUserId);
const mockUpsert = vi.mocked(upsertPersona);
const mockGetPartner = vi.mocked(getPartnerByUserId);
const mockCreatePartner = vi.mocked(createPartnerProfile);

const VALID = {
  persona: "creator",
  displayName: "blessing",
  handle: "blessing",
  bio: "AI experiments",
  category: "ai",
  complete: true,
};

function post(body: unknown) {
  return POST(new Request("http://x/api/persona", { method: "POST", body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ userId: "u-1", name: "blessing" } as never);
  mockPersona.mockResolvedValue(null);
  mockUpsert.mockResolvedValue({
    persona: "CREATOR",
    handle: "blessing",
    category: "ai",
    onboardingCompletedAt: new Date("2026-10-19T12:00:00Z"),
  } as never);
  mockGetPartner.mockResolvedValue(null as never);
  mockCreatePartner.mockResolvedValue({ id: "p-1" } as never);
});

describe("handle syntax (server is authoritative)", () => {
  it("strips one leading @ and lowercases; rejects the rest", () => {
    expect(normalizeHandle("@blessing")).toBe("blessing");
    expect(normalizeHandle("blessing")).toBe("blessing");
    expect(normalizeHandle("Blessing")).toBe("blessing");
    expect(normalizeHandle("@blessing!")).toBeNull();
    expect(normalizeHandle("blessing!")).toBeNull();
    expect(normalizeHandle("ab")).toBeNull();
    expect(normalizeHandle("")).toBeNull();
    expect(isHandleValid("@blessing")).toBe(true);
    expect(isHandleValid("blessing!")).toBe(false);
  });
});

describe("POST /api/persona (onboarding submit path)", () => {
  it("rejects unauthenticated callers, not with 500", async () => {
    session.mockResolvedValue(null);
    const res = await post(VALID);
    expect(res.status).toBe(401);
  });

  it("accepts the valid creator payload, normalizing @blessing", async () => {
    const res = await post({ ...VALID, handle: "@blessing" });
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][1]).toMatchObject({ persona: "creator", handle: "blessing", complete: true });
    const body = await res.json();
    expect(body.persona.handle).toBe("blessing");
    expect(body.partner).toEqual({ id: "p-1" });
    expect(mockCreatePartner).toHaveBeenCalledOnce();
  });

  it("rejects malformed handles with a useful 400, never 500", async () => {
    const res = await post({ ...VALID, handle: "blessing!" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/lowercase letters/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("maps duplicate handles to 409 with a useful message", async () => {
    mockUpsert.mockRejectedValue(Object.assign(new Error("That handle is already taken."), { status: 409 }));
    const res = await post(VALID);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toMatch(/already taken/);
  });

  it("PATCH keeps working for existing clients", async () => {
    const res = await PATCH(
      new Request("http://x/api/persona", { method: "PATCH", body: JSON.stringify(VALID) }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledOnce();
  });

  it("GET still returns the profile shape", async () => {
    mockPersona.mockResolvedValue({
      persona: "CREATOR", handle: "blessing", bio: null, category: "ai", project: null,
      onboardingCompletedAt: null,
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
