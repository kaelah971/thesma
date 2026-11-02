import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const src = (file: string) => readFileSync(join(root, file), "utf8");
const buildSurface = [
  "src/app/build/page.tsx",
  "src/app/build/layout.tsx",
  "src/components/build/DeveloperNav.tsx",
  "src/components/build/DeveloperShell.tsx",
  "src/components/build/DeveloperProjectForm.tsx",
  "src/components/build/DeveloperOutcomeDefinitionForm.tsx",
  "src/components/start/DeveloperIntegrationsPanel.tsx",
].map(src).join("\n");

describe("developer project workspace", () => {
  it("routes completed developer personas to /build and organization personas away from it", () => {
    const context = src("src/app/build/data.ts");
    const organizationShell = src("src/app/app/layout.tsx");
    expect(context).toContain('personaFromEnum(persona.persona) !== "developer"');
    expect(context).toContain('redirect("/start?change=1")');
    expect(organizationShell).toContain('personaFromEnum(persona.persona) === "developer"');
    expect(organizationShell).toContain('redirect("/build")');
  });

  it("uses project-oriented navigation and excludes organization operating surfaces", () => {
    const navigation = src("src/components/build/DeveloperNav.tsx");
    for (const label of ["Overview", "Growth Programs", "Integrations", "Outcome definitions", "Events", "Receipts", "Usage / telemetry", "Docs / quickstart", "Settings"]) {
      expect(navigation).toContain(`label: "${label}"`);
    }
    expect(buildSurface).toContain('wsLabel}>Project');
    expect(navigation).not.toMatch(/href: "\/(app|markets|payout|funding|wallet)/);
    expect(buildSurface).not.toMatch(/Campaigns|Wallets|Payouts|company wallet/i);
  });

  it("creates a project in place and never sends a developer through organization onboarding", () => {
    const form = src("src/components/build/DeveloperProjectForm.tsx");
    expect(form).toContain('fetch("/api/workspaces"');
    expect(form).toContain('category: "developer"');
    expect(form).toContain('router.replace("/build")');
    expect(form).not.toContain("/onboarding/organization");
    expect(src("src/app/build/page.tsx")).toContain("Create a developer project");
  });

  it("exposes the Growth Program foundation without removing the existing API tools", () => {
    expect(src("src/app/build/programs/page.tsx")).toContain("Create a Growth Program");
    expect(src("src/app/build/programs/[id]/page.tsx")).toContain("NOT CONFIGURED");
    expect(src("src/server/services/growthPrograms.ts")).toContain('operatorMode ?? "SHADOW"');
    expect(src("src/app/api/v1/programs/route.ts")).toContain("requireOwner");
    expect(src("src/server/services/buildWithThesma.ts")).toContain("growthProgramId");
  });

  it("keeps developer API tools bounded to the existing project-scoped service", () => {
    expect(src("src/components/start/DeveloperIntegrationsPanel.tsx")).toContain("projectId");
    expect(src("src/components/start/DeveloperIntegrationsPanel.tsx")).toContain("x-thesma-project-id");
    expect(src("src/app/api/v1/integrations/route.ts")).toContain("projectId");
    expect(src("src/app/api/v1/outcomes/route.ts")).toContain("body.projectId");
    expect(src("src/server/services/buildWithThesma.ts")).toContain("listEventStatuses");
    expect(src("src/app/build/events/page.tsx")).toContain("verificationState");
    expect(src("src/app/build/receipts/[id]/page.tsx")).toContain("settlementState");
  });

  it("builds the quickstart from the current request origin", () => {
    const docs = src("src/app/build/docs/page.tsx");
    const overview = src("src/app/build/page.tsx");
    expect(docs).toContain("x-forwarded-host");
    expect(docs).toContain("x-forwarded-proto");
    expect(docs).toContain("/api/v1/outcomes");
    expect(overview).toContain("x-forwarded-host");
    expect(docs).not.toContain("your-thesma-host");
    expect(overview).not.toContain("your-thesma-host");
  });

  it("does not require funding, payments or chain setup for developer intake", () => {
    expect(buildSurface).not.toMatch(/company wallet|campaign funding|Arc connection|payout wallet/i);
    expect(src("src/app/build/docs/page.tsx")).toContain("No financial setup or chain connection is required");
    expect(src("src/app/build/settings/page.tsx")).not.toMatch(/campaign|wallet|payout|funding/i);
  });

  it("keeps Shadow Mode and settlement authority in the existing receipt boundary", () => {
    const outcomeService = src("src/server/services/buildWithThesma.ts");
    const shadowTest = src("tests/build-with-thesma.test.ts");
    expect(outcomeService).toContain('mode === "SHADOW" ? "SHADOW_BLOCKED"');
    expect(outcomeService).toContain('mode === "SHADOW" ? "NOT_EXECUTED"');
    expect(shadowTest).toContain('expect(result.mode).toBe("SHADOW")');
    expect(shadowTest).toContain('expect(result.event.procurementRecommendation).toBe("WOULD_BUY")');
    expect(src("src/app/build/receipts/[id]/page.tsx")).toContain("executionState");
  });
});
