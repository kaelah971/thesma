import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { arcConfigFromEnv, buildApprovalIntent } from "@/server/chain/arc";
import type { Address, Hex } from "viem";

const prepareSchema = z.object({
  workspaceId: z.string().min(1),
  campaignKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  outcomeId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amountMicroUsdc: z.string().regex(/^[1-9]\d*$/),
  proofHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

/**
 * POST /api/operator/approvals/prepare — owner-only unsigned
 * approveObligation calldata for ONE exact obligation. The owner signs in
 * their own wallet (like campaign funding); the backend never signs and
 * never broadcasts here. Testnet operator vault only.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = prepareSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Exact campaignKey, outcomeId, recipient, amount and proofHash are required");
    const { workspaceId, ...p } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const config = arcConfigFromEnv();
    if (!config || config.network !== "testnet" || !config.vaultAddress) {
      return badRequest("Approvals require the testnet operator vault configuration");
    }
    const intent = buildApprovalIntent({
      vault: config.vaultAddress,
      campaignKey: p.campaignKey as Hex,
      outcomeId: p.outcomeId as Hex,
      recipient: p.recipient as Address,
      amountMicroUsdc: BigInt(p.amountMicroUsdc),
      proofHash: p.proofHash as Hex,
    });
    return Response.json({
      chainId: config.chainId,
      network: config.network,
      to: intent.to,
      data: intent.data,
      value: intent.value,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
