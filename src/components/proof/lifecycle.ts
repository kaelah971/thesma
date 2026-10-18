export type LifecycleStepKey = "FUNDED" | "PURCHASED" | "VERIFIED" | "HELD" | "SETTLED";

export type LifecycleStepState = "done" | "active-info" | "active-wait" | "pending" | "terminal";

export interface LifecycleStep {
  key: LifecycleStepKey;
  state: LifecycleStepState;
  sublabel?: string | null;
}

export interface LifecycleInput {
  fundingStatus: string | null;
  verifiedOutcomes: number;
  settledPayouts: number;
  purchaseCount?: number;
  fundedAmount?: string | null;
  verifiedRevenue?: string | null;
  settledTotal?: string | null;
  target?: number | null;
}

/**
 * Canonical public lifecycle derivation. Steps come only from recorded
 * product/chain state — elapsed time never implies settlement, and SETTLED
 * requires genuinely settled payouts.
 */
export function deriveLifecycle(input: LifecycleInput): LifecycleStep[] {
  const fundedDone = input.fundingStatus === "CONFIRMED";
  const fundedActive = !fundedDone && input.fundingStatus !== null;
  const purchased = (input.purchaseCount ?? 0) > 0 || input.verifiedOutcomes > 0;
  const verified = input.verifiedOutcomes > 0;
  const heldWaiting = verified && input.settledPayouts === 0;
  const heldDone = verified && input.settledPayouts > 0;
  const settled = input.settledPayouts > 0;
  const targetSuffix =
    input.target !== null && input.target !== undefined ? ` · ${input.verifiedOutcomes}/${input.target}` : ` · ${input.verifiedOutcomes}`;
  return [
    {
      key: "FUNDED",
      state: fundedDone ? "done" : fundedActive ? "active-info" : "pending",
      sublabel: fundedDone ? (input.fundedAmount ?? "Confirmed onchain") : input.fundingStatus ? input.fundingStatus.toLowerCase() : null,
    },
    {
      key: "PURCHASED",
      state: purchased ? "done" : "pending",
      sublabel: purchased
        ? (input.verifiedRevenue ?? (input.verifiedOutcomes > 0 ? `${input.verifiedOutcomes} verified purchase${input.verifiedOutcomes === 1 ? "" : "s"}` : null))
        : null,
    },
    {
      key: "VERIFIED",
      state: verified ? "done" : "pending",
      sublabel: verified ? `evidence passed${targetSuffix}` : null,
    },
    {
      key: "HELD",
      state: heldDone ? "done" : heldWaiting ? "active-wait" : "pending",
      sublabel: heldDone ? "hold cleared" : heldWaiting ? "safety hold" : null,
    },
    {
      key: "SETTLED",
      state: settled ? "terminal" : "pending",
      sublabel: settled ? (input.settledTotal ?? "reconciled onchain") : null,
    },
  ];
}
