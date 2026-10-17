import { isDbConfigured } from "@/server/db/client";
import { requireUser } from "@/server/auth/guard";
import { createPartnerSchema, updatePartnerSchema } from "@/server/domain/validation";
import {
  createPartnerProfile,
  getPartnerByUserId,
  updatePartnerProfile,
} from "@/server/services/partners";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = createPartnerSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid partner request", parsed.error.flatten());
    const partner = await createPartnerProfile({
      userId: user.userId,
      payoutWallet: parsed.data.payoutWallet ?? null,
      categories: parsed.data.categories,
      rulesJson: parsed.data.rulesJson,
    });
    return Response.json({ partner }, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = updatePartnerSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid partner request", parsed.error.flatten());
    const partner = await updatePartnerProfile({
      userId: user.userId,
      payoutWallet: parsed.data.payoutWallet,
      categories: parsed.data.categories,
      rulesJson: parsed.data.rulesJson,
    });
    return Response.json({ partner });
  } catch (err) {
    return toApiError(err);
  }
}

export async function GET() {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const partner = await getPartnerByUserId(user.userId);
    return Response.json({ partner });
  } catch (err) {
    return toApiError(err);
  }
}
