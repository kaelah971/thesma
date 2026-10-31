/**
 * Mainnet preflight. READ ONLY. NEVER signs. NEVER broadcasts. NEVER prints secrets.
 * Exit 0: no FAIL. Exit 1: at least one FAIL. NOT_CONFIGURED/WARN never crash.
 */
import { Client } from "pg";
import { getAddress } from "viem";
import { arcConfigFromEnv, ViemArcReader } from "../src/server/chain/arc";
import { payoutExecutorFromEnv, proofSignerFromEnv } from "../src/server/chain/signers";
import { isLocalDatabaseUrl, isVerifyFull } from "../src/server/db/tls";

type Status = "PASS" | "WARN" | "FAIL" | "NOT_CONFIGURED";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const EXPECTED_TABLES = [
  "users",
  "workspaces",
  "workspace_members",
  "partners",
  "campaigns",
  "campaign_policy_versions",
  "campaign_fundings",
  "market_states",
  "partner_terms",
  "referrals",
  "attribution_sessions",
  "checkout_intents",
  "outcomes",
  "spend_reservations",
  "payouts",
  "negotiations",
  "market_decisions",
];

function secretCheck(env: NodeJS.ProcessEnv, name: string, minLength: number): Check {
  const value = env[name] ?? "";
  if (!value) return { name: `secret:${name}`, status: "FAIL", detail: "missing" };
  if (value.length < minLength) {
    return { name: `secret:${name}`, status: "FAIL", detail: `present but shorter than ${minLength} chars` };
  }
  return { name: `secret:${name}`, status: "PASS", detail: `present (${value.length} chars, value never shown)` };
}

async function main() {
  const env = process.env;
  const checks: Check[] = [];

  // ---- DATABASE ----
  if (!env.DATABASE_URL) {
    checks.push({ name: "db:configured", status: "FAIL", detail: "DATABASE_URL missing" });
  } else {
    // Explicit TLS posture first: any non-loopback URL is validated as
    // production for this purpose (the preflight's own test-runner env
    // must not weaken the verdict). Static detail only — never the URL,
    // host, or secrets.
    if (isVerifyFull(env.DATABASE_URL)) {
      checks.push({ name: "db:tls", status: "PASS", detail: "sslmode=verify-full" });
    } else if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
      checks.push({ name: "db:tls", status: "FAIL", detail: "set sslmode=verify-full on DATABASE_URL (value hidden)" });
    } else {
      checks.push({ name: "db:tls", status: "WARN", detail: "non-production database URL; verify-full enforced in production" });
    }
    const client = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 10_000 });
    try {
      await client.connect();
      checks.push({ name: "db:reachable", status: "PASS", detail: "connected, SELECT-only checks" });
      const res = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const present = new Set(res.rows.map((r) => r.table_name as string));
      const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
      checks.push(
        missing.length === 0
          ? { name: "db:migrations", status: "PASS", detail: `${EXPECTED_TABLES.length} expected tables present` }
          : { name: "db:migrations", status: "FAIL", detail: `missing tables: ${missing.join(", ")}` },
      );
    } catch (e) {
      checks.push({ name: "db:reachable", status: "FAIL", detail: `unreachable: ${(e as Error).message}` });
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  // ---- APP SECRETS (presence + length only, values never shown) ----
  checks.push(secretCheck(env, "ATTRIBUTION_SECRET", 32));
  checks.push(secretCheck(env, "VERIFIER_INTERNAL_SECRET", 16));
  checks.push(secretCheck(env, "PAYOUT_WORKER_SECRET", 16));
  checks.push(secretCheck(env, "SUPPLY_AGENT_WORKER_SECRET", 16));
  checks.push({
    name: "secret:session",
    status: "PASS",
    detail: "no session secret required (SESSION_COOKIE_NAME optional)",
  });

  // ---- ARC ----
  let arcOk = false;
  let rpcUrl = "";
  let configuredChainId = 0;
  try {
    const config = arcConfigFromEnv();
    if (!config) {
      checks.push({ name: "arc:configured", status: "NOT_CONFIGURED", detail: "ARC_RPC_URL/ARC_CHAIN_ID missing; nothing contacted" });
    } else {
      rpcUrl = config.rpcUrl;
      configuredChainId = config.chainId;
      checks.push({ name: "arc:configured", status: "PASS", detail: `chainId=${config.chainId}` });
      const reader = new ViemArcReader(rpcUrl);
      try {
        const actual = await reader.getChainId();
        if (actual !== configuredChainId) {
          checks.push({ name: "arc:chain-match", status: "FAIL", detail: `rpc=${actual} config=${configuredChainId}` });
        } else {
          checks.push({ name: "arc:chain-match", status: "PASS", detail: `rpc chainId=${actual}` });
          const usdcCode = await reader.hasCode(config.usdcAddress);
          checks.push(
            usdcCode
              ? { name: "arc:usdc-code", status: "PASS", detail: config.usdcAddress }
              : { name: "arc:usdc-code", status: "FAIL", detail: `no code at ${config.usdcAddress}` },
          );
          if (!config.vaultAddress) {
            checks.push({ name: "arc:vault", status: "NOT_CONFIGURED", detail: "THESMA_VAULT_ADDRESS missing" });
          } else {
            const vaultCode = await reader.hasCode(config.vaultAddress);
            checks.push(
              vaultCode
                ? { name: "arc:vault", status: "PASS", detail: config.vaultAddress }
                : { name: "arc:vault", status: "FAIL", detail: `no code at ${config.vaultAddress}` },
            );
            if (vaultCode && env.DATABASE_URL) {
              try {
                const db = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 10_000 });
                await db.connect();
                try {
                  const r = await db.query(
                    "SELECT campaign_key FROM campaign_fundings WHERE status = 'CONFIRMED' ORDER BY confirmed_at DESC NULLS LAST LIMIT 1",
                  );
                  if (r.rows.length === 0) {
                    checks.push({ name: "arc:vault-state", status: "WARN", detail: "no CONFIRMED funding to cross-check onchain" });
                  } else {
                    const key = r.rows[0].campaign_key as `0x${string}`;
                    const st = await reader.readVaultCampaign(config.vaultAddress, key);
                    const execOk = !config.executorAddress || st.executor?.toLowerCase() === config.executorAddress.toLowerCase();
                    const verOk = !config.verifierAddress || st.verifier?.toLowerCase() === config.verifierAddress.toLowerCase();
                    checks.push(
                      execOk && verOk
                        ? {
                            name: "arc:vault-state",
                            status: "PASS",
                            detail: `funded=${st.funded} spent=${st.spent} paused=${st.paused} closed=${st.closed}`,
                          }
                        : { name: "arc:vault-state", status: "FAIL", detail: "onchain executor/verifier mismatch configured addresses" },
                    );
                  }
                } finally {
                  await db.end().catch(() => undefined);
                }
              } catch (e) {
                checks.push({ name: "arc:vault-state", status: "WARN", detail: `db cross-check skipped: ${(e as Error).message}` });
              }
            }
          }
          arcOk = true;
        }
      } catch (e) {
        checks.push({ name: "arc:rpc", status: "FAIL", detail: `unreachable: ${(e as Error).message}` });
      }
    }
  } catch (e) {
    checks.push({ name: "arc:configured", status: "FAIL", detail: `misconfigured: ${(e as Error).message}` });
  }
  void arcOk;

  // ---- SIGNERS (derive only; keys never printed, never used to sign) ----
  try {
    const signer = proofSignerFromEnv();
    if (!signer) {
      checks.push({ name: "signer:verifier", status: "FAIL", detail: "THESMA_VERIFIER_PRIVATE_KEY missing (payout settlement requires it)" });
    } else {
      const expected = env.THESMA_VERIFIER_ADDRESS ? getAddress(env.THESMA_VERIFIER_ADDRESS) : null;
      checks.push(
        !expected || expected === signer.address
          ? { name: "signer:verifier", status: "PASS", detail: `derives to ${signer.address}` }
          : { name: "signer:verifier", status: "FAIL", detail: "derived address mismatches THESMA_VERIFIER_ADDRESS" },
      );
    }
  } catch (e) {
    checks.push({ name: "signer:verifier", status: "FAIL", detail: (e as Error).message });
  }
  try {
    const executor = rpcUrl ? payoutExecutorFromEnv(rpcUrl, configuredChainId || 1) : null;
    if (!executor) {
      checks.push({ name: "signer:executor", status: "FAIL", detail: "THESMA_EXECUTOR_PRIVATE_KEY missing (payout submission requires it)" });
    } else {
      const expected = env.THESMA_EXECUTOR_ADDRESS ? getAddress(env.THESMA_EXECUTOR_ADDRESS) : null;
      checks.push(
        !expected || expected === executor.address
          ? { name: "signer:executor", status: "PASS", detail: `derives to ${executor.address}` }
          : { name: "signer:executor", status: "FAIL", detail: "derived address mismatches THESMA_EXECUTOR_ADDRESS" },
      );
    }
  } catch (e) {
    checks.push({ name: "signer:executor", status: "FAIL", detail: (e as Error).message });
  }

  // ---- PUBLIC APP ----
  const origin = env.APP_ORIGIN ?? env.APP_URL ?? env.PUBLIC_APP_URL ?? env.VERCEL_URL ?? "";
  checks.push(
    origin
      ? { name: "app:public-url", status: "PASS", detail: "public market URL derivable (/markets)" }
      : { name: "app:public-url", status: "WARN", detail: "no APP_ORIGIN/equivalent; derive from deployment URL" },
  );
  checks.push(
    env.ARC_EXPLORER_BASE_URL
      ? { name: "app:explorer", status: "PASS", detail: "explorer links enabled" }
      : { name: "app:explorer", status: "WARN", detail: "ARC_EXPLORER_BASE_URL missing; tx hashes shown as text" },
  );

  const failed = checks.filter((c) => c.status === "FAIL").length;
  for (const c of checks) console.log(`${c.status} ${c.name} :: ${c.detail}`);
  console.log(JSON.stringify({ overall: failed === 0 ? "READY_OR_DEGRADED" : "BLOCKED", failed }));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL preflight :: ${(e as Error).message}`);
  process.exit(1);
});
