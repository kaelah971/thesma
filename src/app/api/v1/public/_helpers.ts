import { toApiError } from "@/server/api/errors";

export function withPublicCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "content-type");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function publicError(error: unknown): Response {
  return withPublicCors(toApiError(error));
}

export function publicJson(body: unknown, init?: ResponseInit): Response {
  return withPublicCors(Response.json(body, init));
}
