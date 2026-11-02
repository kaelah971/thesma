import { isDbConfigured } from "@/server/db/client";
import { errorResponse, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

const MAX_REQUEST_BYTES = 128 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_REQUEST_BYTES) return errorResponse("PAYLOAD_TOO_LARGE", `Request must be smaller than ${MAX_REQUEST_BYTES} bytes.`, 413);
    const service = createProductionOutcomeApiService();
    const principal = await service.authenticate(req);
    const { slug } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await service.submitEvent({
      principal,
      slug,
      idempotencyKey: req.headers.get("idempotency-key"),
      input: body,
    });
    return Response.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (err) {
    return toApiError(err);
  }
}
