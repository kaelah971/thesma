import { checkoutDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { createCheckoutIntentSchema } from "@/server/domain/checkout";
import { createCheckoutIntent } from "@/server/services/checkout";

/** Customer-facing: no Thesma account required. Returns unsigned transfer only. */
export async function POST(req: Request) {
  try {
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const body = await req.json().catch(() => null);
    const parsed = createCheckoutIntentSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid checkout intent request", parsed.error.flatten());
    const result = await createCheckoutIntent(wired.deps, {
      attributionHandle: parsed.data.attributionHandle,
      payerAddress: parsed.data.payerAddress,
      amountMicroUsdc: parsed.data.amountMicroUsdc,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
