import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production-UX regression: the organization Settings wallet experience
 * shows a clean verified-wallet view with no temporary debugging surfaces.
 *
 * The registered company wallet view must contain a verified status plus
 * the truncated registered address, and must never render diagnostic
 * internals (hashes, recovered signers, provider ids, routing logs).
 * Internal test coverage for EIP-712, recovery, challenges, and error
 * classification lives in the wallet unit suites — this file pins the UX.
 */

const root = join(__dirname, "..");

describe("registered company wallet view", () => {
  it("shows verified status with the truncated registered address", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(src).toContain("Company wallet");
    expect(src).toContain("Verified");
    expect(src).toContain("Used to sign and fund campaigns.");
    expect(src).toContain("Change wallet");
    expect(src).toContain("truncateAddress(account)");
  });

  it("contains no diagnostic surfaces", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(src).not.toMatch(/diagnostic/i);
    expect(src).not.toMatch(/temporary/i);
    expect(src).not.toMatch(/debug/i);
    expect(src).not.toContain("client typed-data hash");
    expect(src).not.toContain("server typed-data hash");
    expect(src).not.toContain("Client recovered signer");
    expect(src).not.toContain("Server recovered signer");
    expect(src).not.toContain("uuid");
    expect(src).not.toContain("UUID");
    expect(src).not.toContain("Request routing");
    expect(src).not.toContain("routing logs");
    expect(src).not.toContain("SIGNATURE REQUEST FAILED");
  });

  it("settings keeps the wallet/vault distinction and custody truth", () => {
    const src = readFileSync(join(root, "src/app/app/settings/page.tsx"), "utf8");
    expect(src).toContain("Company wallet");
    expect(src).toContain("Campaign vault");
    expect(src).toContain("Thesma never stores your wallet keys.");
    expect(src).toContain("Verified");
    expect(src).not.toMatch(/diagnostic/i);
  });
});
