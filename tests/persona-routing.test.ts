import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProductPersonaIntent } from "@/server/services/personas";

const root = process.cwd();
const src = (file: string) => readFileSync(join(root, file), "utf8");

function resolve(input: Partial<Parameters<typeof resolveProductPersonaIntent>[0]>) {
  return resolveProductPersonaIntent({
    persistedPersona: null,
    selectedPersona: null,
    explicitPersona: null,
    legacyDeveloperSignal: false,
    ...input,
  });
}

describe("product persona shell routing", () => {
  it("routes an existing developer owner to /build, regardless of workspace owner role", () => {
    expect(resolve({ persistedPersona: "developer", selectedPersona: "organization" })).toEqual({ persona: "developer", shouldPersist: false });
    const appLayout = src("src/app/app/layout.tsx");
    expect(appLayout).toContain('personaFromEnum(persona.persona) === "developer"');
    expect(appLayout).toContain('redirect("/build")');
    expect(appLayout).not.toContain('role === "ORGANIZATION_OWNER"');
  });

  it("covers /app/settings through the shared app layout and keeps /build refresh-gated", () => {
    expect(src("src/app/app/layout.tsx")).toContain("export default async function AppLayout");
    expect(src("src/app/build/data.ts")).toContain('redirect("/start?change=1")');
    expect(src("src/app/build/data.ts")).toContain('personaFromEnum(persona.persona) !== "developer"');
  });

  it("does not infer Organization from ownership", () => {
    expect(resolve({ persistedPersona: "developer", legacyDeveloperSignal: true }).persona).toBe("developer");
    expect(resolve({ persistedPersona: "organization", selectedPersona: "organization" }).persona).toBe("organization");
    expect(src("src/server/services/personas.ts")).toContain("workspace membership is never changed or used as an organization-persona grant");
  });

  it("honors explicit Change role intents", () => {
    expect(resolve({ persistedPersona: "developer", explicitPersona: "organization" })).toEqual({ persona: "organization", shouldPersist: true });
    expect(resolve({ persistedPersona: "organization", explicitPersona: "developer" })).toEqual({ persona: "developer", shouldPersist: true });
    expect(src("src/app/api/persona/select/route.ts")).toContain("serializePersonaIntentCookie");
  });

  it("keeps an organization owner in /app when Organization is persisted", () => {
    expect(resolve({ persistedPersona: "organization", selectedPersona: "organization" })).toEqual({ persona: "organization", shouldPersist: false });
  });

  it("recovers a pre-fix developer account once, without creating a tenant", () => {
    expect(resolve({ persistedPersona: "organization", selectedPersona: "developer", legacyDeveloperSignal: true })).toEqual({ persona: "developer", shouldPersist: true });
    const personas = src("src/server/services/personas.ts");
    expect(personas).toContain("resolveProductPersona");
    expect(personas).toContain("upsertPersona(params.userId");
    expect(personas).not.toContain("createWorkspaceWithOwner");
  });

  it("uses the persisted persona after recovery and preserves authorization boundaries", () => {
    expect(resolve({ persistedPersona: "developer", selectedPersona: "organization", legacyDeveloperSignal: true }).shouldPersist).toBe(false);
    expect(src("src/app/app/data.ts")).toContain("listUserWorkspaces");
    expect(src("src/app/api/v1/integrations/route.ts")).toContain("requireOwner");
    expect(src("src/server/auth/guard.ts")).toContain("hashSessionToken");
  });
});
