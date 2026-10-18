import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function runPreflight(env: Record<string, string | undefined>) {
  const scrubbed: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !["DATABASE_URL", "ARC_RPC_URL", "ARC_CHAIN_ID", "ATTRIBUTION_SECRET", "VERIFIER_INTERNAL_SECRET", "PAYOUT_WORKER_SECRET", "SUPPLY_AGENT_WORKER_SECRET", "THESMA_VERIFIER_PRIVATE_KEY", "THESMA_EXECUTOR_PRIVATE_KEY", "APP_ORIGIN", "ARC_EXPLORER_BASE_URL", "THESMA_VAULT_ADDRESS"].includes(k)) {
      scrubbed[k] = v;
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete scrubbed[k];
    else scrubbed[k] = v;
  }
  return execFileAsync("npx", ["tsx", "./scripts/mainnet-preflight.ts"], {
    cwd: "C:/dev/thesma",
    env: scrubbed as NodeJS.ProcessEnv,
    timeout: 60_000,
    shell: process.platform === "win32",
  }).then(
    (r) => ({ code: 0 as number, stdout: r.stdout, stderr: r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    }),
  );
}

describe("mainnet preflight (read-only)", () => {
  it("runs safely with nothing configured and never leaks sentinels", async () => {
    const sentinel = "sentinel-secret-value-xyz-1234567890";
    const r = await runPreflight({
      DATABASE_URL: undefined,
      ARC_RPC_URL: undefined,
      ARC_CHAIN_ID: undefined,
      SUPPLY_AGENT_WORKER_SECRET: sentinel,
      PAYOUT_WORKER_SECRET: sentinel,
    });
    // Missing DB/keys block readiness, but the command itself must only report.
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("NOT_CONFIGURED");
    expect(r.stdout).not.toContain(sentinel);
    expect(r.stdout).not.toContain("0x");
  }, 60_000);

  it("detects chain mismatch without signing or broadcasting", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const id = JSON.parse(body).id ?? 1;
        // eth_chainId -> 9999, eth_getCode -> empty
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x270f" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await runPreflight({
        DATABASE_URL: undefined,
        ARC_RPC_URL: `http://127.0.0.1:${port}`,
        ARC_CHAIN_ID: "5042",
        SUPPLY_AGENT_WORKER_SECRET: undefined,
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/FAIL arc:chain-match/);
      expect(r.stdout).toContain("rpc=9999 config=5042");
    } finally {
      server.close();
    }
  }, 60_000);
});
