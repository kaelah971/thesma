import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { userPersonas } from "@/server/db/schema";
import { badRequest, toApiError } from "@/server/api/errors";
import { normalizeHandle } from "@/server/services/personas";
import {
  createDrizzleFollowStore,
  isPublicCreatorIdentity,
} from "@/server/services/creatorProfiles";

const bodySchema = z.object({ handle: z.string().trim().min(1).max(34) });

async function resolveCreatorUserId(handle: string): Promise<string | null> {
  // Only public creators can be followed; identity resolves server-side.
  const normalized = normalizeHandle(handle);
  if (!normalized) return null;
  const [row] = await getDb()
    .select()
    .from(userPersonas)
    .where(eq(userPersonas.handle, normalized))
    .limit(1)
    .catch(() => []);
  if (!isPublicCreatorIdentity(row ?? null)) return null;
  return row.userId;
}

/**
 * POST /api/creator/follow {handle} — idempotent follow.
 * DELETE /api/creator/follow {handle} — idempotent unfollow.
 * Identity always resolves server-side from the handle; client IDs are
 * never trusted. Auth required (the button routes logged-out users
 * through /signin?next=/@handle first).
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("A creator handle is required");
    const creatorUserId = await resolveCreatorUserId(parsed.data.handle);
    if (!creatorUserId) return badRequest("Creator not found");
    const follows = createDrizzleFollowStore();
    const { following } = await follows.follow(user.userId, creatorUserId);
    return Response.json({ following, followerCount: await follows.followerCount(creatorUserId) });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("A creator handle is required");
    const creatorUserId = await resolveCreatorUserId(parsed.data.handle);
    if (!creatorUserId) return badRequest("Creator not found");
    const follows = createDrizzleFollowStore();
    const { following } = await follows.unfollow(user.userId, creatorUserId);
    return Response.json({ following, followerCount: await follows.followerCount(creatorUserId) });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
