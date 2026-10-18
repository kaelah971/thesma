import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { answerAgentQuestion } from "@/server/services/supplyAgent";

/** "What is my agent doing?" Read-only answers over real state. */
export async function POST(req: Request) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const question = typeof body?.question === "string" ? body.question : "";
    if (!question.trim()) return badRequest("A question is required");
    const result = await answerAgentQuestion(wired.deps, { userId: user.userId, question });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
