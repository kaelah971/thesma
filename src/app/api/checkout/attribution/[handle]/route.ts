import { checkoutDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { resolveAttributionMetadata } from "@/server/services/checkout";

/**
 * Public pre-purchase metadata for an attribution handle. No Thesma account
 * required. Read-only: never consumes the handle, never creates state.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  try {
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const { handle } = await ctx.params;
    if (!handle || handle.length > 200) return badRequest("Invalid purchase reference");
    const result = await resolveAttributionMetadata(wired.deps, { attributionHandle: handle });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
