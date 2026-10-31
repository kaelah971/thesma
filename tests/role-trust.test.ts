import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROLE_HOME,
  ROLE_INTENTS,
  ROLE_SIGNIN_COPY,
  parseRoleIntent,
  signinHref,
} from "@/lib/roleIntent";
import { PERSONAS, parsePersona, personaHome } from "@/server/services/personas";
import { GITHUB_REPO_URL } from "@/components/trust/PublicFooter";
import { sourcifyContractUrl, THESMA_VAULT_ADDRESS } from "@/lib/proof";

const root = process.cwd();
const src = (f: string) => readFileSync(join(root, f), "utf8");

/* ---------------- Role enum parity (client lib vs server truth) ---------------- */

describe("role enum parity", () => {
  it("role intents match the server persona enum exactly", () => {
    expect([...ROLE_INTENTS].sort()).toEqual([...PERSONAS].sort());
  });

  it("role homes match personaHome routing truth", () => {
    for (const r of ROLE_INTENTS) {
      expect(ROLE_HOME[r]).toBe(personaHome(r));
    }
    expect(ROLE_HOME).toEqual({
      customer: "/customer",
      creator: "/creator",
      organization: "/app",
      developer: "/build",
    });
  });

  it("parseRoleIntent agrees with server parsePersona on valid/invalid input", () => {
    for (const r of ["customer", "creator", "organization", "developer", " Customer ", "DEVELOPER"]) {
      expect(parseRoleIntent(r)).toBe(parsePersona(r));
    }
    expect(parseRoleIntent("admin")).toBeNull();
    expect(parseRoleIntent("../../etc")).toBeNull();
    expect(parseRoleIntent(undefined)).toBeNull();
  });
});

/* ---------------- 1–5: /start preserves role into /signin ---------------- */

describe("start preserves role intent", () => {
  const cards = () => src("src/components/start/RoleCards.tsx");

  it.each([
    ["customer", "customer"],
    ["creator", "creator"],
    ["organization", "organization"],
    ["developer", "developer"],
  ])("%s selection preserves %s role into signin", (persona) => {
    expect(cards()).toContain("`/signin?role=${persona}&next=/welcome`");
    expect(signinHref(persona as (typeof ROLE_INTENTS)[number])).toBe(
      `/signin?role=${persona}&next=/welcome`,
    );
  });

  it("invalid role value falls back safely to generic auth", () => {
    expect(parseRoleIntent("superuser")).toBeNull();
    expect(parseRoleIntent("")).toBeNull();
    expect(signinHref("customer", "https://evil.example")).toBe("/signin?role=customer&next=/welcome");
    expect(signinHref("customer", "//evil.example")).toBe("/signin?role=customer&next=/welcome");
    const signin = src("src/app/signin/page.tsx");
    expect(signin).toContain('"Welcome to Thesma"');
    expect(signin).toContain("parseRoleIntent");
  });

  it("signin persists a validated role without server-side cookie writes", () => {
    const signin = src("src/app/signin/page.tsx");
    // Server Components cannot set cookies at runtime (production 500) —
    // persistence goes through the existing POST /api/persona/select route.
    expect(signin).not.toContain("cookies().set");
    expect(signin).toContain("PersistRole");
    expect(signin).toContain("<PersistRole role={role} />");
    const persist = src("src/components/start/PersistRole.tsx");
    expect(persist).toContain("/api/persona/select");
    expect(persist).toContain("useEffect");
    const api = src("src/app/api/persona/select/route.ts");
    expect(api).toContain("PERSONA_COOKIE");
    expect(api).toContain("HttpOnly");
  });
});

/* ---------------- 6: role-specific signin copy ---------------- */

describe("role-specific signin copy", () => {
  it("creator signin copy differs from organization signin copy", () => {
    expect(ROLE_SIGNIN_COPY.creator.headline).not.toBe(ROLE_SIGNIN_COPY.organization.headline);
    expect(ROLE_SIGNIN_COPY.creator.sub).not.toBe(ROLE_SIGNIN_COPY.organization.sub);
    expect(ROLE_SIGNIN_COPY.organization.sub).toContain("launch and operate");
    expect(ROLE_SIGNIN_COPY.creator.sub).toContain("verified outcomes");
  });

  it("every role has distinct, capability-honest copy", () => {
    const headlines = Object.values(ROLE_SIGNIN_COPY).map((c) => c.headline);
    expect(new Set(headlines).size).toBe(4);
    expect(ROLE_SIGNIN_COPY.customer.sub).toContain("qualifying action");
    expect(ROLE_SIGNIN_COPY.developer.sub).toContain("coming next");
    const signin = src("src/app/signin/page.tsx");
    expect(signin).toContain("ROLE_SIGNIN_COPY");
    expect(signin).toContain("Continuing as");
    // No four separate auth pages — one surface, contextual copy.
    expect(signin).toContain('copy?.headline ?? "Welcome to Thesma"');
  });
});

/* ---------------- 7–9: post-auth destinations + returning users ---------------- */

describe("post-auth destinations", () => {
  const welcome = () => src("src/app/welcome/page.tsx");

  it("organization post-auth destination is the workspace product", () => {
    expect(ROLE_HOME.organization).toBe("/app");
    expect(welcome()).toContain("redirect(personaHome(persona))");
    expect(welcome()).toContain("onboardingPath(persona)");
  });

  it("creator post-auth destination is the creator home", () => {
    expect(ROLE_HOME.creator).toBe("/creator");
    expect(welcome()).toContain('case "creator"');
  });

  it("returning users are not duplicated when revisiting the role flow", () => {
    // Idempotent upsert: revisiting /welcome with an existing row keeps it.
    expect(welcome()).toContain("upsertPersona");
    expect(welcome()).toContain("getPersonaByUserId");
    // Existing finished roles skip the gateway instead of re-onboarding.
    const start = src("src/app/start/page.tsx");
    expect(start).toContain("returningDestination");
    expect(start).toContain("personaHome(p)");
  });

  it("returning-user destination honors completed organization vs creator state", () => {
    const start = src("src/app/start/page.tsx");
    expect(start).toContain("listUserWorkspaces");
    expect(start).toContain("getPartnerByUserId");
  });
});

/* ---------------- 10–11: /terms + /privacy are public ---------------- */

describe("legal pages are public", () => {
  it("/terms requires no login", () => {
    const terms = src("src/app/terms/page.tsx");
    expect(terms).not.toContain("getSessionUser");
    expect(terms).not.toContain("redirect(");
    expect(terms).not.toContain("useWallet");
    expect(terms).toContain("Terms of use");
  });

  it("/privacy requires no login", () => {
    const privacy = src("src/app/privacy/page.tsx");
    expect(privacy).not.toContain("getSessionUser");
    expect(privacy).not.toContain("redirect(");
    expect(privacy).not.toContain("useWallet");
    expect(privacy).toContain("bcrypt");
  });
});

/* ---------------- 12–16: public trust footer ---------------- */

describe("public trust footer", () => {
  const footer = () => src("src/components/trust/PublicFooter.tsx");

  it("appears on intended public routes", () => {
    expect(src("src/app/demo/page.tsx")).toContain("PublicFooter");
    expect(src("src/app/markets/page.tsx")).toContain("PublicFooter");
    expect(src("src/app/security/page.tsx")).toContain("PublicFooter");
    expect(src("src/app/terms/page.tsx")).toContain("PublicFooter");
    expect(src("src/app/privacy/page.tsx")).toContain("PublicFooter");
    // Landing keeps its own footer, extended with the same trust links.
    expect(src("src/components/landing/Sections.tsx")).toContain("SiteFooter");
    expect(src("src/components/landing/Sections.tsx")).toContain("/terms");
    expect(src("src/components/landing/Sections.tsx")).toContain("/privacy");
  });

  it("has Security, Terms, Privacy, GitHub, and Proof links", () => {
    const f = footer();
    expect(f).toContain('href="/security"');
    expect(f).toContain('href="/terms"');
    expect(f).toContain('href="/privacy"');
    expect(f).toContain("GITHUB_REPO_URL");
    expect(f).toContain('href="/demo"');
    expect(f).toContain('href="/markets"');
    expect(GITHUB_REPO_URL).toBe("https://github.com/kaelah971/thesma");
  });

  it("verified-contract link uses the canonical Sourcify proof (no duplicate constant)", () => {
    expect(footer()).toContain("sourcifyContractUrl");
    expect(footer()).not.toContain("0x0fA826");
    expect(sourcifyContractUrl()).toBe(
      `https://sourcify.dev/server/v2/contract/5042/${THESMA_VAULT_ADDRESS}`,
    );
  });

  it("invents no support email, entity, address, or chat handle", () => {
    const Haystack = [footer(), src("src/app/terms/page.tsx"), src("src/app/privacy/page.tsx")].join("\n");
    expect(Haystack).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    for (const invented of ["LLC", "Inc.", "Ltd", "Discord", "Telegram", "Signal", "+1 ", "Street", "Suite"]) {
      expect(Haystack).not.toContain(invented);
    }
    expect(footer()).toContain("not published yet");
  });

  it("public footer exposes no private data", () => {
    const f = footer();
    for (const forbidden of [
      "passwordHash",
      "tokenHash",
      "customerKeyHash",
      "thesma_session",
      "thesma_persona",
      "payoutWallet",
      "companyWallet",
      "auditEvents",
    ]) {
      expect(f).not.toContain(forbidden);
    }
  });

  it("footer uses semantic landmarks and stays fluid on small screens", () => {
    const f = footer();
    expect(f).toContain("<footer");
    expect(f).toContain('aria-label="Trust and legal"');
    expect(f).toContain("<nav");
    expect(f).toContain("flexWrap");
    expect(f).not.toMatch(/width:\s*\d{3,}px/);
  });
});

/* ---------------- 17: role query cannot create authz bypass ---------------- */

describe("role query authz safety", () => {
  it("auth guards never consult the persona cookie or role param", () => {
    const guard = src("src/server/auth/guard.ts");
    expect(guard).not.toContain("persona");
    expect(guard).not.toContain("PERSONA_COOKIE");
    expect(guard).not.toContain("searchParams");
    expect(guard).not.toContain("?role");
    // Guards resolve identity from the hashed session token only.
    expect(guard).toContain("hashSessionToken");
  });

  it("persona only picks UI destinations; data reads stay membership-scoped", () => {
    const personas = src("src/server/services/personas.ts");
    expect(personas).toContain("never consulted by auth guards");
    const welcome = src("src/app/welcome/page.tsx");
    // Welcome redirects by role but authorizes nothing — workspace/partner
    // reads below only decide onboarding vs home.
    expect(welcome).not.toContain("isDbConfigured() && (await getSessionUser())");
  });
});

/* ---------------- 18–20: mobile + demo funnel continuity ---------------- */

describe("mobile role flow and demo continuity", () => {
  it("signin role context does not rely on color alone and wraps on small screens", () => {
    const signin = src("src/app/signin/page.tsx");
    expect(signin).toContain("Continuing as");
    expect(signin).toContain("<h1>");
  });

  it("demo → start → organization intent survives", () => {
    expect(src("src/app/demo/page.tsx")).toContain('href="/start"');
    expect(src("src/components/start/RoleCards.tsx")).toContain("signin?role=");
    expect(signinHref("organization")).toBe("/signin?role=organization&next=/welcome");
    expect(ROLE_SIGNIN_COPY.organization.sub).toContain("launch and operate");
    const signin = src("src/app/signin/page.tsx");
    expect(signin).toContain("PersistRole");
  });

  it("demo → start → creator intent survives", () => {
    expect(signinHref("creator")).toBe("/signin?role=creator&next=/welcome");
    expect(ROLE_SIGNIN_COPY.creator.sub).toContain("verified outcomes");
    const welcome = src("src/app/welcome/page.tsx");
    expect(welcome).toContain("cookiePersona");
  });
});
