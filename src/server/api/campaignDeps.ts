import { isDbConfigured } from "@/server/db/client";
import { arcConfigFromEnv, ViemArcReader } from "@/server/chain/arc";
import { createDrizzleCampaignStore, drizzleAuditSink } from "@/server/services/campaignStore.drizzle";
import type { CampaignDeps } from "@/server/services/campaigns";
import type { FundingDeps } from "@/server/services/fundings";
import type { MarketDeps } from "@/server/services/markets";
import type { CheckoutDeps } from "@/server/services/checkout";
import type { PayoutDeps } from "@/server/services/payouts";
import { payoutExecutorFromEnv, proofSignerFromEnv } from "@/server/chain/signers";
import { toApiError, unconfigured } from "@/server/api/errors";

export function campaignDepsOr503(): { deps: CampaignDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  return { deps: { store: createDrizzleCampaignStore(), audit: drizzleAuditSink } };
}

export function marketDepsOr503(): { deps: MarketDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  return { deps: { store: createDrizzleCampaignStore(), audit: drizzleAuditSink } };
}

export function checkoutDepsOr503(): { deps: CheckoutDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  const config = arcConfigFromEnv();
  return {
    deps: {
      store: createDrizzleCampaignStore(),
      audit: drizzleAuditSink,
      config,
      reader: config ? new ViemArcReader(config.rpcUrl) : null,
    },
  };
}

export function payoutWorkerDepsOr503(): { deps: PayoutDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  const config = arcConfigFromEnv();
  if (!config) return { response: unconfigured() };
  let signer: PayoutDeps["signer"];
  let executor: PayoutDeps["executor"];
  try {
    signer = proofSignerFromEnv();
    executor = payoutExecutorFromEnv(config.rpcUrl, config.chainId);
  } catch (e) {
    return { response: toApiError(e) };
  }
  if (!signer || !executor) {
    return { response: unconfigured() };
  }
  return {
    deps: {
      store: createDrizzleCampaignStore(),
      audit: drizzleAuditSink,
      config,
      reader: new ViemArcReader(config.rpcUrl),
      signer,
      executor,
    },
  };
}

export function fundingDepsOr503(): { deps: FundingDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  const config = arcConfigFromEnv();
  return {
    deps: {
      store: createDrizzleCampaignStore(),
      audit: drizzleAuditSink,
      config,
      reader: config ? new ViemArcReader(config.rpcUrl) : null,
    },
  };
}
