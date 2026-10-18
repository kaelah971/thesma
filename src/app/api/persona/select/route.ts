import { isDbConfigured } from "@/server/db/client";
import { PERSONA_COOKIE, parsePersona, serializePersonaCookie } from "@/server/services/personas";

/**
 * Pre-auth persona choice. No account needed: validates the slug and stores
 * it in an HttpOnly cookie so the role survives the signin/signup redirect.
 * Never grants anything — /welcome re-resolves everything server-side.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const persona = parsePersona(body?.persona);
  if (!persona) {
    return Response.json({ error: "Choose customer, creator, organization or developer." }, { status: 400 });
  }
  void isDbConfigured();
  const secure = new URL(req.url).protocol === "https:";
  return new Response(JSON.stringify({ ok: true, persona }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": serializePersonaCookie(persona, secure),
    },
  });
}
