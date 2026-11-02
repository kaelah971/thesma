import { isDbConfigured } from "@/server/db/client";
import {
  parsePersona,
  serializePersonaCookie,
  serializePersonaIntentCookie,
} from "@/server/services/personas";

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
  // PERSONA_COOKIE is the durable selection; the short-lived intent cookie
  // distinguishes an explicit role switch from a legacy stale selection.
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", serializePersonaCookie(persona, secure));
  headers.append("Set-Cookie", serializePersonaIntentCookie(persona, secure));
  return new Response(JSON.stringify({ ok: true, persona }), { status: 200, headers });
}
