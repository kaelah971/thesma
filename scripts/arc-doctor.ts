/**
 * Read-only Arc doctor. NEVER signs or broadcasts.
 * Exit 0: healthy or clearly NOT CONFIGURED. Exit 1: reachable but wrong.
 */
import { arcConfigFromEnv, ViemArcReader } from "../src/server/chain/arc";

function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

async function main() {
  let config;
  try {
    config = arcConfigFromEnv();
  } catch (e) {
    console.log(JSON.stringify({ status: "MISCONFIGURED", error: (e as Error).message }));
    process.exit(1);
  }
  if (!config) {
    console.log(
      JSON.stringify({
        status: "NOT_CONFIGURED",
        hint: "Set ARC_CHAIN_ID and ARC_RPC_URL (see .env.example). Nothing was contacted.",
      }),
    );
    return;
  }

  const report: Record<string, unknown> = {
    status: "OK",
    network: config.network ?? "mainnet",
    environment: config.environmentLabel ?? "Arc Mainnet",
    rpc: redactRpc(config.rpcUrl),
    configuredChainId: config.chainId,
    usdcAddress: config.usdcAddress,
    vaultAddress: config.vaultAddress,
    executorAddress: config.executorAddress,
    verifierAddress: config.verifierAddress,
    explorerBaseUrl: config.explorerBaseUrl,
  };

  const reader = new ViemArcReader(config.rpcUrl);
  try {
    const actualChainId = await reader.getChainId();
    report.rpcChainId = actualChainId;
    report.chainMatch = actualChainId === config.chainId;
    if (!report.chainMatch) {
      report.status = "CHAIN_MISMATCH";
      console.log(JSON.stringify(report));
      process.exit(1);
    }
  } catch (e) {
    report.status = "RPC_UNREACHABLE";
    report.error = (e as Error).message;
    console.log(JSON.stringify(report));
    process.exit(1);
  }

  report.usdcHasCode = await reader.hasCode(config.usdcAddress);
  if (config.vaultAddress) {
    report.vaultHasCode = await reader.hasCode(config.vaultAddress);
    try {
      report.vaultUsdcBalanceMicro = (await reader.usdcBalanceOf(config.usdcAddress, config.vaultAddress)).toString();
    } catch (e) {
      report.vaultBalanceError = (e as Error).message;
    }
  }
  console.log(JSON.stringify(report));
}

main().catch((e) => {
  console.log(JSON.stringify({ status: "ERROR", error: (e as Error).message }));
  process.exit(1);
});
