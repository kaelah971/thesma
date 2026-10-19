import { eq } from "drizzle-orm";
import { z } from "zod";
import { isDbConfigured, getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { getSessionUser } from "@/server/auth/guard";
import { badRequest, conflict, toApiError, unauthorized, unconfigured } from "@/server/api/errors";
import { getPartnerByUserId, createPartnerProfile } from "@/server/services/partners";
import { listUserWorkspaces } from "@/server/services/workspaces";
import {
  CREATOR_TYPES,
  PERSONAS,
  getPersonaByUserId,
  isHandleValid,
  normalizeCreatorType,
  normalizeHandle,
  parsePersona,
  personaFromEnum,
  upsertPersona,
} from "@/server/services/personas";

const patchSchema = z.object({
  persona: z.enum(PERSONAS).optional(),
  displayName: z.string().trim().max(100).nullish(),
  handle: z.string().trim().max(34).nullish(),
  bio: z.string().trim().max(500).nullish(),
  category: z.string().trim().max(100).nullish(),
  project: z.string().trim().max(500).nullish(),
  creatorType: z.enum(CREATOR_TYPES).nullish(),
  interests: z.union([z.string().max(500), z.array(z.string().max(60)).max(20)]).nullish(),
  preferences: z.union([z.string().max(500), z.array(z.string().max(60)).max(10)]).nullish(),
  complete: z.boolean().optional(),
});

export async function GET() {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const [persona, partner, memberships] = await Promise.all([
      getPersonaByUserId(user.userId),
      getPartnerByUserId(user.userId).catch(() => null),
      listUserWorkspaces(user.userId).catch(() => []),
    ]);
    return Response.json({
      user,
      persona: persona
        ? {
            persona: personaFromEnum(persona.persona),
            handle: persona.handle,
            bio: persona.bio,
            category: persona.category,
            project: persona.project,
            creatorType: persona.creatorType ?? null,
            interests: [...(persona.interests ?? [])],
            preferences: [...(persona.preferences ?? [])],
            onboardingCompletedAt: persona.onboardingCompletedAt?.toISOString() ?? null,
          }
        : null,
      partner: partner ? { id: partner.id, categories: partner.categories, hasPayoutWallet: Boolean(partner.payoutWallet) } : null,
      workspaceCount: memberships.length,
    });
  } catch (err) {
    return toApiError(err);
  }
}

async function writeProfile(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid profile request", parsed.error.flatten());
    const data = parsed.data;

    const existing = await getPersonaByUserId(user.userId);
    const persona = data.persona ?? (existing ? personaFromEnum(existing.persona) : null) ?? parsePersona(null);
    if (!data.persona && !existing) return badRequest("Choose a role first.");

    const handle = data.handle === undefined || data.handle === null || data.handle === "" ? undefined : normalizeHandle(data.handle);
    if (data.handle && data.handle.trim() && !handle) {
      return badRequest("Handle must be 3–30 lowercase letters, numbers or underscores.");
    }
    if (data.handle && !isHandleValid(data.handle)) {
      return badRequest("Handle must be 3–30 lowercase letters, numbers or underscores.");
    }
    if (data.creatorType !== undefined && data.creatorType !== null && !normalizeCreatorType(data.creatorType)) {
      return badRequest("Creator type must be Creator, KOL or Developer.");
    }

    if (data.displayName?.trim()) {
      await getDb().update(users).set({ name: data.displayName.trim().slice(0, 100), updatedAt: new Date() }).where(eq(users.id, user.userId));
    }

    let row;
    try {
      row = await upsertPersona(user.userId, {
        persona: data.persona ?? personaFromEnum(existing!.persona)!,
        ...(handle !== undefined ? { handle } : {}),
        ...(data.bio !== undefined ? { bio: data.bio } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.project !== undefined ? { project: data.project } : {}),
        ...(data.creatorType !== undefined ? { creatorType: data.creatorType } : {}),
        ...(data.interests !== undefined ? { interests: data.interests } : {}),
        ...(data.preferences !== undefined ? { preferences: data.preferences } : {}),
        ...(data.complete ? { complete: true } : {}),
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) return conflict("That handle is already taken.");
      throw err;
    }

    // Creator foundation: one partner profile per user, created once with the
    // onboarding category. No financial effect — terms/referrals come later.
    const effective = personaFromEnum(row.persona);
    let partner = await getPartnerByUserId(user.userId).catch(() => null);
    if (effective === "creator" && data.complete && !partner) {
      const categories = row.category ? [row.category] : [];
      try {
        partner = await createPartnerProfile({ userId: user.userId, categories });
      } catch (err) {
        if ((err as { status?: number }).status !== 409) throw err;
        partner = await getPartnerByUserId(user.userId).catch(() => null);
      }
    }

    return Response.json({
      persona: {
        persona: effective,
        handle: row.handle,
        onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
      },
      partner: partner ? { id: partner.id } : null,
    });
  } catch (err) {
    return toApiError(err);
  }
}

export async function PATCH(req: Request) {
  return writeProfile(req);
}

/**
 * All onboarding forms submit here via POST. Shares the PATCH write path
 * exactly — PATCH is kept so existing clients keep working.
 */
export async function POST(req: Request) {
  return writeProfile(req);
}
