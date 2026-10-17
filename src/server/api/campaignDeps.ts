import { isDbConfigured } from "@/server/db/client";
import { createDrizzleCampaignStore, drizzleAuditSink } from "@/server/services/campaignStore.drizzle";
import type { CampaignDeps } from "@/server/services/campaigns";
import { unconfigured } from "@/server/api/errors";

export function campaignDepsOr503(): { deps: CampaignDeps } | { response: Response } {
  if (!isDbConfigured()) return { response: unconfigured() };
  return { deps: { store: createDrizzleCampaignStore(), audit: drizzleAuditSink } };
}
