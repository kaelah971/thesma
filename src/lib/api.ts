/** Extracts a render-safe string from a JSON error envelope. Never returns an object (React cannot render one). */
export function serverErrorMessage(res: { error?: { message?: string } | string } | null, fallback: string): string {
  if (!res) return fallback;
  const err = res.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && typeof err.message === "string" && err.message) return err.message;
  return fallback;
}

/** Reads the backend's typed error envelope ({ error: { message } }) for inline display. */
export async function apiError(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "Network error — check your connection and try again.";
  if (res.status === 503) return "This deployment isn't configured for that action yet.";
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: await apiError(res, "Request failed.") };
  return { ok: true, data: (await res.json()) as T };
}

export async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: await apiError(res, "Request failed.") };
  return { ok: true, data: (await res.json()) as T };
}
