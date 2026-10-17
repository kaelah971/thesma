import { isDbConfigured } from "@/server/db/client";
import { arcConfigFromEnv, ViemArcReader } from "@/server/chain/arc";
import { createDrizzleCampaignStore, drizzleAuditSink } from "@/server/services/campaignStore.drizzle";
import type { CampaignDeps } from "@/server/services/campaigns";
import type { FundingDeps } from "@/server/services/fundings";
import type { MarketDeps } from "@/server/services/markets";
import { unconfigured } from "@/server/api/errors";

export function campaignDepsOr503(): { deps: CampaignDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  return { deps: { store: createDrizzleCampaignStore(), audit: drizzleAuditSink } };
}

export function marketDepsOr503(): { deps: MarketDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  return { deps: { store: createDrizzleCampaignStore(), audit: drizzleAuditSink } };
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
