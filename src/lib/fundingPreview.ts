/**
 * Failure-contained funding-preview normalization (client safe,
 * dependency-free). The prepare endpoint historically returned a SHORTER
 * shape than the resume endpoint (no `completed`, no `confirmReady`,
 * typed as if present) — feeding that DTO straight into preview state
 * crashed the whole route on first render (`completed.length` of
 * undefined). Every consumer MUST normalize through here: missing or
 * malformed fields degrade to a safe empty preview, never a throw.
 */

export type PreviewPurpose = "create-campaign" | "approve-usdc" | "fund-campaign";

export interface PreviewAction {
  purpose: PreviewPurpose;
  chainId: number;
  to: string;
  data: string;
  value: string;
  expectedSender: string;
  expectedAmountMicroUsdc?: string;
}

export interface FundingPreview {
  actions: PreviewAction[];
  completed: PreviewPurpose[];
  confirmReady: boolean;
}

const PURPOSES: ReadonlySet<string> = new Set(["create-campaign", "approve-usdc", "fund-campaign"]);

function isPreviewAction(value: unknown): value is PreviewAction {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.purpose === "string" &&
    PURPOSES.has(a.purpose) &&
    typeof a.chainId === "number" &&
    typeof a.to === "string" &&
    typeof a.data === "string" &&
    typeof a.value === "string" &&
    typeof a.expectedSender === "string" &&
    (a.expectedAmountMicroUsdc === undefined || typeof a.expectedAmountMicroUsdc === "string")
  );
}

/**
 * Normalize any prepare/resume DTO (or garbage) into a render-safe
 * preview. Never throws; never returns undefined fields.
 */
export function normalizeFundingPreview(data: unknown): FundingPreview {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const actions = Array.isArray(d.actions) ? d.actions.filter(isPreviewAction) : [];
  const completed = Array.isArray(d.completed)
    ? d.completed.filter((c): c is PreviewPurpose => typeof c === "string" && PURPOSES.has(c))
    : [];
  return { actions, completed, confirmReady: d.confirmReady === true };
}

/** Render-safe message for a preview failure. Never returns an object. */
export function previewErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && typeof err.message === "string" && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}
