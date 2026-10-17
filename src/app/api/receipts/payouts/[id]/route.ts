import { isDbConfigured } from "@/server/db/client";
import { arcConfigFromEnv } from "@/server/chain/arc";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { toApiError, unconfigured } from "@/server/api/errors";
import { getPayoutReceipt } from "@/server/services/payouts";

/**
 * Human-readable payout receipt. Truthful language only: SUBMITTED is
 * broadcast, SETTLED means chain reconciliation passed. VERIFIED never
 * meant paid.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const { id } = await ctx.params;
    const receipt = await getPayoutReceipt(createDrizzleCampaignStore(), { payoutId: id }, {
      explorerBaseUrl: arcConfigFromEnv()?.explorerBaseUrl ?? null,
    });
    return Response.json(receipt);
  } catch (err) {
    return toApiError(err);
  }
}
