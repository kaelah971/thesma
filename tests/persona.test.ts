import { describe, expect, it } from "vitest";
import {
  isHandleValid,
  normalizeHandle,
  onboardingPath,
  parsePersona,
  personaFromEnum,
  personaHome,
  personaToEnum,
} from "@/server/services/personas";

describe("role gateway persona helpers", () => {
  it("parses only the four known slugs", () => {
    expect(parsePersona("customer")).toBe("customer");
    expect(parsePersona("CREATOR")).toBe("creator");
    expect(parsePersona(" organization ")).toBe("organization");
    expect(parsePersona("developer")).toBe("developer");
    expect(parsePersona("admin")).toBeNull();
    expect(parsePersona("PARTNER")).toBeNull();
    expect(parsePersona(undefined)).toBeNull();
    expect(parsePersona({ role: "customer" })).toBeNull();
  });

  it("never maps a persona to an elevated workspace route", () => {
    expect(personaHome("customer")).toBe("/customer");
    expect(personaHome("creator")).toBe("/creator");
    expect(personaHome("developer")).toBe("/build");
    // Organization keeps the existing membership-scoped workspace product.
    expect(personaHome("organization")).toBe("/app");
  });

  it("routes each persona to its own onboarding", () => {
    expect(onboardingPath("customer")).toBe("/onboarding/customer");
    expect(onboardingPath("creator")).toBe("/onboarding/creator");
    expect(onboardingPath("organization")).toBe("/onboarding/organization");
    expect(onboardingPath("developer")).toBe("/onboarding/developer");
  });

  it("round-trips the DB enum", () => {
    expect(personaToEnum("customer")).toBe("CUSTOMER");
    expect(personaFromEnum("CREATOR")).toBe("creator");
    expect(personaFromEnum("wizard")).toBeNull();
  });

  it("validates optional creator handles without inventing truth", () => {
    expect(normalizeHandle("@Alice_01")).toBe("alice_01");
    expect(normalizeHandle("  BOB ")).toBe("bob");
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("ab")).toBeNull();
    expect(normalizeHandle("has space")).toBeNull();
    expect(isHandleValid("")).toBe(true);
    expect(isHandleValid(undefined)).toBe(true);
    expect(isHandleValid("ok_handle_1")).toBe(true);
    expect(isHandleValid("1k")).toBe(false);
  });
});
