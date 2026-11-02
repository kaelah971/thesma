export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PublicProgramConfig {
  id: string;
  slug: string;
  name: string;
  objectiveOutcomeType: string;
  outcomeSlug: string;
  targetOutcomeCount: number;
  participantTypes: string[];
  rewardStructure: string;
  rewardCeilingMicroUsdc: string;
  participationStatus: "CLOSED" | "INVITE_ONLY" | "OPEN";
  status: string;
  operatorMode: "SHADOW" | "REVIEW" | "AUTONOMOUS";
  productUrl: string | null;
  participationUrl: string;
  attribution: { enabled: true; parameter: "ref" };
  verification: { outcomeName: string; outcomeType: string; evidenceFields: string[]; holdSeconds: number };
  settlement: { status: "SHADOW_NOT_FUNDED"; execution: "NOT_EXECUTED" };
  joinable: boolean;
}

export interface StoredAttribution {
  status: "ATTRIBUTED";
  programId: string;
  programSlug: string;
  attributionId: string;
  capturedAt: string;
  participantDisplayName?: string;
  participantHandle?: string | null;
}

export type CaptureAttributionResult = StoredAttribution | {
  status: "NONE" | "REFUSED";
  programSlug: string;
  reason?: string;
};

export interface ThesmaBrowserClientOptions {
  baseUrl: string;
  program: string;
  referralParam?: string;
  storage?: BrowserStorage | null;
  fetch?: typeof fetch;
}

function safeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Thesma browser client baseUrl must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Thesma browser client baseUrl must use HTTP(S).");
  return url.toString().replace(/\/$/, "");
}

function safeProgram(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(value)) throw new Error("Thesma browser client program must be a public program slug.");
  return value;
}

function browserStorage(): BrowserStorage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function parseJson(response: Response): Promise<Record<string, unknown> | null> {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>;
}

export function buildReferralUrl(params: { destination: string; referralCode: string; parameter?: string }): string {
  if (typeof params.referralCode !== "string" || !/^[A-Za-z0-9_-]{2,200}$/.test(params.referralCode)) throw new Error("Referral code is invalid.");
  const parameter = params.parameter ?? "ref";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(parameter)) throw new Error("Referral parameter is invalid.");
  let destination: URL;
  try { destination = new URL(params.destination); } catch { throw new Error("Referral destination must be an absolute HTTP(S) URL."); }
  if ((destination.protocol !== "https:" && destination.protocol !== "http:") || destination.username || destination.password) throw new Error("Referral destination must be a credential-free HTTP(S) URL.");
  destination.searchParams.set(parameter, params.referralCode);
  return destination.toString();
}

export function createThesmaBrowserClient(options: ThesmaBrowserClientOptions) {
  if (Object.prototype.hasOwnProperty.call(options as object, "apiKey")) throw new Error("Thesma API keys are server-only and cannot be used by the browser client.");
  const baseUrl = safeBaseUrl(options.baseUrl);
  const program = safeProgram(options.program);
  const referralParam = options.referralParam ?? "ref";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(referralParam)) throw new Error("Referral parameter is invalid.");
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const fetchImpl = options.fetch ?? fetch;
  const storageKey = `thesma:attribution:${program}`;

  async function publicRequest(path: string) {
    const response = await fetchImpl(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
    const data = await parseJson(response);
    if (!response.ok) {
      const error = data?.error as { code?: string; message?: string } | undefined;
      throw Object.assign(new Error(error?.message ?? "Thesma public request failed."), { code: error?.code ?? "PUBLIC_REQUEST_FAILED", status: response.status });
    }
    return data;
  }

  function getAttribution(): StoredAttribution | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<StoredAttribution>;
      if (value.status !== "ATTRIBUTED" || value.programSlug !== program || typeof value.programId !== "string" || typeof value.attributionId !== "string" || typeof value.capturedAt !== "string") return null;
      return value as StoredAttribution;
    } catch { return null; }
  }

  function clearAttribution(): void {
    try { storage?.removeItem(storageKey); } catch { /* browser storage can be disabled */ }
  }

  async function getProgram(): Promise<PublicProgramConfig> {
    const data = await publicRequest(`/api/v1/public/programs/${encodeURIComponent(program)}`);
    return data?.program as PublicProgramConfig;
  }

  async function captureAttribution(params?: { url?: string | URL }): Promise<CaptureAttributionResult> {
    const source = params?.url ? new URL(params.url.toString(), typeof window === "undefined" ? undefined : window.location.href) : typeof window === "undefined" ? null : new URL(window.location.href);
    const code = source?.searchParams.get(referralParam)?.trim() ?? "";
    if (!code) return { status: "NONE", programSlug: program };
    try {
      const data = await publicRequest(`/api/v1/public/programs/${encodeURIComponent(program)}/attribution/${encodeURIComponent(code)}`);
      const attribution = data?.attribution as { status?: string; programId?: string; programSlug?: string; attributionId?: string; capturedAt?: string; participant?: { displayName?: string; handle?: string | null } } | undefined;
      if (attribution?.status !== "ATTRIBUTED" || typeof attribution.programId !== "string" || typeof attribution.attributionId !== "string") throw new Error("The attribution response was incomplete.");
      const stored: StoredAttribution = { status: "ATTRIBUTED", programId: attribution.programId, programSlug: program, attributionId: attribution.attributionId, capturedAt: attribution.capturedAt ?? new Date().toISOString(), participantDisplayName: attribution.participant?.displayName, participantHandle: attribution.participant?.handle };
      try { storage?.setItem(storageKey, JSON.stringify(stored)); } catch { /* attribution still returns even when storage is unavailable */ }
      return stored;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Attribution could not be resolved.";
      return { status: "REFUSED", programSlug: program, reason };
    }
  }

  return { getProgram, captureAttribution, getAttribution, clearAttribution, program, baseUrl };
}
