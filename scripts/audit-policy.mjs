/**
 * Deterministic dependency-security gate for CI.
 *
 * Policy: FAIL on any critical or high advisory. Moderate/low advisories
 * are reported but do not fail — the current residuals are dev-tooling-only
 * (nested esbuild via drizzle-kit/tsx, minimatch via the eslint chain) and
 * their offered fixes require unrelated majors/downgrades (see README).
 *
 * Usage: node scripts/audit-policy.mjs (after `npm ci`; no install needed).
 * Never runs `npm audit fix --force`.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

// exec (shell) rather than execFile: portable across Windows (.cmd shims)
// and Linux runners without platform branches.
const run = promisify(exec);

// npm audit exits non-zero when advisories exist — the JSON report still
// arrives on stdout, so capture it from the rejection instead of failing.
let stdout;
try {
  ({ stdout } = await run("npm audit --json", { maxBuffer: 16 * 1024 * 1024 }));
} catch (e) {
  if (!e || typeof e.stdout !== "string" || !e.stdout) throw e;
  stdout = e.stdout;
}
const audit = JSON.parse(stdout);

const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
const blocking = [];
const moderateTitles = new Set();

for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
  counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  if (v.severity === "critical" || v.severity === "high") {
    blocking.push(`${v.severity} ${name} range=${v.range} fix=${JSON.stringify(v.fixAvailable)}`);
  }
  if (v.severity === "moderate" && Array.isArray(v.via)) {
    for (const ref of v.via) {
      if (ref && typeof ref === "object" && ref.title) moderateTitles.add(`${ref.title} [${ref.url ?? "no url"}]`);
    }
  }
}

console.log(`npm audit severity counts: ${JSON.stringify(counts)}`);
if (moderateTitles.size > 0) {
  console.log("Residual moderate advisories (visible, non-blocking):");
  for (const t of [...moderateTitles].sort()) console.log(`  - ${t}`);
}

if (blocking.length > 0) {
  console.error("AUDIT POLICY: FAIL — new critical/high advisories:");
  for (const b of blocking) console.error(`  - ${b}`);
  process.exit(1);
}
console.log("AUDIT POLICY: pass (critical=0, high=0)");
