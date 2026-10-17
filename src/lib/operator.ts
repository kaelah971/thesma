/**
 * Thesma operator: deterministic answers over the live workspace snapshot.
 * No model is wired — every reply is a fixed template over real state, in
 * the backend's truthful vocabulary (VERIFIED ≠ paid, SUBMITTED ≠ settled).
 */
import { campaignName, formatUsdc, shortHash } from "./format";
import {
  campaignFinancials,
  outcomeRows,
  STAGE_LABEL,
  STAGE_TONE,
  verifiedCount,
  workspaceFinancials,
  type OutcomeRow,
  type Tone,
  type WorkspaceSnapshot,
} from "./readmodel";

export type OperatorIntent =
  | "status"
  | "awaiting"
  | "explain"
  | "budget"
  | "verified"
  | "receipts"
  | "holds"
  | "draft"
  | "help";

export type OperatorBlock =
  | { kind: "facts"; title?: string; items: { label: string; value: string }[] }
  | { kind: "list"; items: { title: string; meta: string; tone: Tone; badge: string; href?: string }[] }
  | { kind: "link"; label: string; href: string };

export interface OperatorReply {
  intent: OperatorIntent;
  text: string;
  blocks: OperatorBlock[];
  /** Set when the user supplied a campaign description to draft via the real API. */
  draftIntent?: string;
}

export const SUGGESTED_PROMPTS = [
  "Show campaign status",
  "What is awaiting verification?",
  "Explain this payout",
  "Show available budget",
  "List verified outcomes",
  "Draft a campaign",
] as const;

export const DRAFT_EXAMPLE =
  "Draft: Acquire 50 paying customers with a budget of 5000 USDC, floor 40 USDC, up to 80 USDC per customer, only purchases of at least 30 USDC, by 2026-12-31.";

export function classifyIntent(query: string): OperatorIntent {
  const q = query.trim().toLowerCase();
  if (/^(draft|create|launch|new)\b.*\bcampaign|^draft\b/.test(q)) return "draft";
  if (/\b(why|explain|hasn.?t|not (been )?paid|stuck)\b/.test(q)) return "explain";
  if (/\b(await|awaiting|pending|queue|unverified)\b/.test(q)) return "awaiting";
  if (/\bholds?\b/.test(q)) return "holds";
  if (/\b(budget|available|funded|spend|spent|money|balance)\b/.test(q)) return "budget";
  if (/\b(receipts?|settled|paid out|settlements?)\b/.test(q)) return "receipts";
  if (/\bverified\b|\boutcomes?\b/.test(q)) return "verified";
  if (/\b(status|overview|summary|how.*(going|doing)|campaigns?)\b/.test(q)) return "status";
  return "help";
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function durationWords(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(plural(days, "day", "days"));
  if (hours) parts.push(plural(hours, "hour", "hours"));
  if (minutes && !days) parts.push(plural(minutes, "minute", "minutes"));
  return parts.join(" ") || "1 minute";
}

function nameOf(snap: WorkspaceSnapshot, campaignId: string) {
  return campaignName(snap.campaigns.find((c) => c.id === campaignId)?.intentText);
}

function outcomeItem(snap: WorkspaceSnapshot, r: OutcomeRow) {
  return {
    title: `Outcome ${r.id.slice(0, 8)}`,
    meta: `${formatUsdc(r.purchaseAmountMicro)} USDC purchase · ${nameOf(snap, r.campaignId)}`,
    tone: STAGE_TONE[r.stage],
    badge:
      r.stage === "SAFETY_HOLD" && r.holdRemainingMs !== null
        ? `Hold · ${durationWords(r.holdRemainingMs)}`
        : STAGE_LABEL[r.stage],
    href: r.payout ? `/app/payouts/${r.payout.id}` : `/app/outcomes?campaign=${r.campaignId}`,
  };
}

function holdSentence(holds: OutcomeRow[]): string {
  if (holds.length === 0) return "No verified outcomes are in a safety hold.";
  const soonest = holds.reduce((a, b) => ((a.holdRemainingMs ?? 0) <= (b.holdRemainingMs ?? 0) ? a : b));
  const lead =
    holds.length === 1
      ? "1 verified outcome is currently in its safety hold."
      : `${holds.length} verified outcomes are currently in their safety hold.`;
  return `${lead} ${holds.length === 1 ? "Payout" : "The next payout"} becomes eligible in ${durationWords(soonest.holdRemainingMs ?? 0)}.`;
}

export function answerOperator(query: string, snap: WorkspaceSnapshot, now: number): OperatorReply {
  const intent = classifyIntent(query);
  const rows = outcomeRows(snap, now);
  const holds = rows.filter((r) => r.stage === "SAFETY_HOLD");
  const hasCampaigns = snap.campaigns.length > 0;

  if (intent === "draft") {
    const content = query.replace(/^\s*(draft|create|launch|new)( a)?( new)?( campaign)?\s*[:\-–—]?\s*/i, "").trim();
    if (content.length >= 24) {
      return {
        intent,
        text: "Preparing a draft policy from your description. Nothing is funded or published until an owner approves it.",
        blocks: [],
        draftIntent: content,
      };
    }
    return {
      intent,
      text: "Describe the outcome in one message and I'll prepare a draft policy. Include the target count, budget, floor, maximum per outcome, minimum purchase and an explicit deadline (YYYY-MM-DD). I never guess missing amounts or dates.",
      blocks: [
        { kind: "facts", title: "Example", items: [{ label: "Message", value: DRAFT_EXAMPLE }] },
        { kind: "link", label: "Open the campaign form", href: "/app/campaigns/new" },
      ],
    };
  }

  if (!hasCampaigns && intent !== "help") {
    return {
      intent,
      text: "This workspace has no campaigns yet, so there's nothing to report. Start by drafting the outcome you're willing to pay for.",
      blocks: [{ kind: "link", label: "Draft a campaign", href: "/app/campaigns/new" }],
    };
  }

  switch (intent) {
    case "status": {
      const live = snap.campaigns.filter((c) => c.state === "LIVE").length;
      const focus = snap.campaigns.find((c) => c.state === "LIVE") ?? snap.campaigns[0];
      const f = campaignFinancials(focus.id, snap);
      const target = focus.targetOutcomeCount;
      const verified = verifiedCount(snap, focus.id);
      return {
        intent,
        text: `${live} of ${plural(snap.campaigns.length, "campaign", "campaigns")} ${live === 1 ? "is" : "are"} live. ${holdSentence(holds)}`,
        blocks: [
          {
            kind: "facts",
            title: campaignName(focus.intentText),
            items: [
              { label: "State", value: focus.state },
              { label: "Verified outcomes", value: target ? `${verified} of ${target}` : String(verified) },
              { label: "Available budget", value: `${formatUsdc(f.available)} USDC` },
              { label: "Settled payouts", value: `${formatUsdc(f.settled)} USDC` },
            ],
          },
          { kind: "link", label: "Open campaign", href: `/app/campaigns/${focus.id}` },
        ],
      };
    }
    case "holds": {
      return {
        intent,
        text: `${holdSentence(holds)} Holds protect against refunds: a verified outcome cannot be paid until its campaign's hold window has passed.`,
        blocks: holds.length ? [{ kind: "list", items: holds.map((r) => outcomeItem(snap, r)) }] : [],
      };
    }
    case "awaiting": {
      const pending = rows.filter((r) => r.stage === "AWAITING_VERIFICATION");
      return {
        intent,
        text: pending.length
          ? `${plural(pending.length, "outcome is", "outcomes are")} awaiting verification. The verifier reads the purchase onchain independently — payment, recipient, amount, minimum and uniqueness must all match before anything becomes payable.`
          : "Nothing is awaiting verification right now. New purchases appear here as soon as they're submitted.",
        blocks: pending.length ? [{ kind: "list", items: pending.slice(0, 8).map((r) => outcomeItem(snap, r)) }] : [],
      };
    }
    case "verified": {
      const verified = rows.filter((r) => r.status === "VERIFIED");
      return {
        intent,
        text: verified.length
          ? `${plural(verified.length, "outcome has", "outcomes have")} passed verification. Verified means the evidence checked out — it does not mean the partner has been paid yet.`
          : "No outcomes have been verified yet.",
        blocks: verified.length
          ? [
              { kind: "list", items: verified.slice(0, 8).map((r) => outcomeItem(snap, r)) },
              { kind: "link", label: "View all outcomes", href: "/app/outcomes" },
            ]
          : [],
      };
    }
    case "budget": {
      const total = workspaceFinancials(snap);
      const funded = snap.campaigns.filter((c) => campaignFinancials(c.id, snap).funded > 0n);
      return {
        intent,
        text: funded.length
          ? `${formatUsdc(total.available)} USDC is available across ${plural(funded.length, "funded campaign", "funded campaigns")}. Available is funded budget minus everything already committed: active reservations, settled payouts and accepted negotiation commitments.`
          : "No campaign has confirmed funding yet. Budget only counts once the funding transaction is confirmed onchain.",
        blocks: [
          {
            kind: "facts",
            title: "Workspace budget",
            items: [
              { label: "Funded", value: `${formatUsdc(total.funded)} USDC` },
              { label: "Committed", value: `${formatUsdc(total.committed)} USDC` },
              { label: "Settled", value: `${formatUsdc(total.settled)} USDC` },
              { label: "Available", value: `${formatUsdc(total.available)} USDC` },
            ],
          },
        ],
      };
    }
    case "receipts": {
      const settled = snap.payouts.filter((p) => p.state === "SETTLED");
      return {
        intent,
        text: settled.length
          ? `${plural(settled.length, "payout has", "payouts have")} settled. Settled means the chain was reconciled against a matching OutcomePaid event — every receipt below is inspectable.`
          : "No payouts have settled yet. A payout is only called settled after onchain reconciliation.",
        blocks: settled.length
          ? [
              {
                kind: "list",
                items: settled.slice(0, 8).map((p) => ({
                  title: `${formatUsdc(p.amountMicro)} USDC to ${shortHash(p.recipient)}`,
                  meta: `${nameOf(snap, p.campaignId)} · tx ${shortHash(p.txHash)}`,
                  tone: "mint" as Tone,
                  badge: "Settled",
                  href: `/app/payouts/${p.id}`,
                })),
              },
            ]
          : [],
      };
    }
    case "explain": {
      const priority: OutcomeRow["stage"][] = ["SAFETY_HOLD", "AMBIGUOUS", "ELIGIBLE", "SUBMITTED", "RESERVED", "FAILED", "SETTLED"];
      const target = priority
        .map((stage) =>
          rows
            .filter((r) => r.stage === stage)
            .sort((a, b) => (a.holdRemainingMs ?? 0) - (b.holdRemainingMs ?? 0))[0],
        )
        .find(Boolean);
      if (!target) {
        return {
          intent,
          text: "There's no payout to explain yet. Payouts only begin after an outcome passes verification.",
          blocks: [],
        };
      }
      const explanations: Record<string, string> = {
        SAFETY_HOLD: `The outcome is verified, but settlement is intentionally blocked until the campaign hold expires. The hold clears in ${durationWords(target.holdRemainingMs ?? 0)}; then budget is reserved at the partner's frozen price, submitted onchain and reconciled.`,
        AMBIGUOUS: "The payout was broadcast but its chain receipt couldn't be matched yet. Thesma reconciles before it retries — it never resends a payment blindly.",
        ELIGIBLE: "The safety hold has cleared. The payout worker will reserve budget at the frozen partner price on its next pass.",
        RESERVED: "Budget is reserved for this outcome and the payout is prepared. The next step is a signed, single broadcast through the executor.",
        SUBMITTED: "The payout has been broadcast. It isn't called settled until reconciliation finds the matching OutcomePaid event onchain.",
        FAILED: "The payout failed onchain evidence checks, so its reservation was released and the budget returned to available. Nothing was paid twice.",
        SETTLED: "This payout settled: reconciliation matched the vault, outcome, recipient, amount and proof onchain.",
      };
      return {
        intent,
        text: explanations[target.stage],
        blocks: [
          {
            kind: "facts",
            title: `Outcome ${target.id.slice(0, 8)}`,
            items: [
              { label: "Campaign", value: nameOf(snap, target.campaignId) },
              { label: "Stage", value: STAGE_LABEL[target.stage] },
              { label: "Purchase", value: `${formatUsdc(target.purchaseAmountMicro)} USDC` },
              { label: "Proof", value: shortHash(target.proofHash) },
            ],
          },
          ...(target.payout ? [{ kind: "link" as const, label: "Open receipt", href: `/app/payouts/${target.payout.id}` }] : []),
        ],
      };
    }
    default:
      return {
        intent: "help",
        text: "I answer from this workspace's live state — campaigns, outcomes, holds, budget and receipts. Try one of these:",
        blocks: [],
      };
  }
}
