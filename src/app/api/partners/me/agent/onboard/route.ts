import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { nextOnboardingQuestion, onboardingSummary, parseOnboardingAnswers } from "@/server/domain/supplyAgent";

/**
 * Conversational onboarding turn. Interprets free-text answers into a typed
 * draft and returns the next question. Persists NOTHING.
 */
export async function POST(req: Request) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    await requireUser();
    const body = await req.json().catch(() => null);
    const answers = (body?.answers ?? {}) as Record<string, string>;
    const parsed = parseOnboardingAnswers({
      categoriesText: answers.categories,
      blockedCategoriesText: answers.blockedCategories,
      minBountyText: answers.minBounty,
      maxActiveText: answers.maxActive,
      maxAllocationText: answers.maxAllocation,
      autoJoinText: answers.autoJoin,
      autoNegotiateText: answers.autoNegotiate,
    });
    const next = nextOnboardingQuestion(parsed);
    return Response.json({
      draft: parsed.rules,
      missing: parsed.missing,
      nextQuestion: next,
      confirmationCard: next === null ? onboardingSummary(parsed.rules) : null,
      readyToConfirm: next === null,
    });
  } catch (err) {
    return toApiError(err);
  }
}
