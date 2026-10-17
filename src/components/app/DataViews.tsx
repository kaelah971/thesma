import Link from "next/link";
import { Rail } from "@/components/ui/Rail";
import { campaignName, formatDateTime, formatDuration, formatRelative, formatUsdc, shortHash } from "@/lib/format";
import {
  activityLabel,
  activityTone,
  PAYOUT_STATE_TONE,
  RAIL,
  railIndex,
  STAGE_LABEL,
  STAGE_TONE,
  type ActivityView,
  type CampaignView,
  type OutcomeRow,
  type OutcomeStage,
  type PayoutView,
} from "@/lib/readmodel";
import { Pill } from "./ui";
import styles from "./app.module.css";

const nameMap = (campaigns: CampaignView[]) => new Map(campaigns.map((c) => [c.id, campaignName(c.intentText)]));

export function StagePill({ row }: { row: Pick<OutcomeRow, "stage" | "holdRemainingMs"> }) {
  return (
    <Pill tone={STAGE_TONE[row.stage]}>
      {row.stage === "SAFETY_HOLD" && row.holdRemainingMs !== null
        ? `Hold · ${formatDuration(row.holdRemainingMs)}`
        : STAGE_LABEL[row.stage]}
    </Pill>
  );
}

export function OutcomeTable({ rows, campaigns, showCampaign = true }: { rows: OutcomeRow[]; campaigns: CampaignView[]; showCampaign?: boolean }) {
  const names = nameMap(campaigns);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Outcome</th>
            {showCampaign && <th>Campaign</th>}
            <th className={styles.num}>Purchase</th>
            <th>Stage</th>
            <th>Verified</th>
            <th>Proof</th>
            <th className={styles.num}>Payout</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div className={styles.cellTitle}>
                  <span className="mono">{r.id.slice(0, 8)}</span>
                  <small className="mono">tx {shortHash(r.purchaseTx)}</small>
                </div>
              </td>
              {showCampaign && (
                <td>
                  <Link href={`/app/campaigns/${r.campaignId}`} className={styles.truncate}>
                    {names.get(r.campaignId) ?? "Campaign"}
                  </Link>
                </td>
              )}
              <td className={styles.num}>{formatUsdc(r.purchaseAmountMicro)} USDC</td>
              <td>
                <div className={styles.cellTitle}>
                  <span>
                    <StagePill row={r} />
                  </span>
                  {r.rejectionCode && <small className="mono">{r.rejectionCode}</small>}
                </div>
              </td>
              <td className={styles.muted}>{formatDateTime(r.verifiedAt)}</td>
              <td className="mono">{shortHash(r.proofHash)}</td>
              <td className={styles.num}>
                {r.payout ? (
                  <Link href={`/app/payouts/${r.payout.id}`}>{formatUsdc(r.payout.amountMicro)} USDC</Link>
                ) : r.reservation ? (
                  <span>{formatUsdc(r.reservation.amountMicro)} USDC</span>
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PayoutTable({ payouts, campaigns, showCampaign = true }: { payouts: PayoutView[]; campaigns: CampaignView[]; showCampaign?: boolean }) {
  const names = nameMap(campaigns);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Payout</th>
            {showCampaign && <th>Campaign</th>}
            <th className={styles.num}>Amount</th>
            <th>State</th>
            <th>Recipient</th>
            <th>Transaction</th>
            <th>Settled</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id}>
              <td>
                <Link href={`/app/payouts/${p.id}`} className="mono">
                  {p.id.slice(0, 8)}
                </Link>
              </td>
              {showCampaign && (
                <td>
                  <Link href={`/app/campaigns/${p.campaignId}`} className={styles.truncate}>
                    {names.get(p.campaignId) ?? "Campaign"}
                  </Link>
                </td>
              )}
              <td className={styles.num}>{formatUsdc(p.amountMicro)} USDC</td>
              <td>
                <div className={styles.cellTitle}>
                  <span>
                    <Pill tone={PAYOUT_STATE_TONE[p.state]}>{p.state === "AMBIGUOUS" ? "Reconciling" : p.state.charAt(0) + p.state.slice(1).toLowerCase()}</Pill>
                  </span>
                  {p.failureCode && <small className="mono">{p.failureCode}</small>}
                </div>
              </td>
              <td className="mono">{shortHash(p.recipient)}</td>
              <td className="mono">{shortHash(p.txHash)}</td>
              <td className={styles.muted}>{formatDateTime(p.settledAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PIPELINE: OutcomeStage[] = ["AWAITING_VERIFICATION", "SAFETY_HOLD", "ELIGIBLE", "RESERVED", "SUBMITTED", "AMBIGUOUS", "SETTLED", "FAILED", "REJECTED"];

export const STAGE_FILTER: Partial<Record<OutcomeStage, string>> = {
  AWAITING_VERIFICATION: "awaiting",
  SAFETY_HOLD: "hold",
  ELIGIBLE: "eligible",
  RESERVED: "settlement",
  SUBMITTED: "settlement",
  AMBIGUOUS: "settlement",
  SETTLED: "settled",
  FAILED: "rejected",
  REJECTED: "rejected",
};

export function Pipeline({ counts, campaignId }: { counts: Record<OutcomeStage, number>; campaignId?: string }) {
  const stages = PIPELINE.filter((s) => counts[s] > 0 || ["AWAITING_VERIFICATION", "SAFETY_HOLD", "ELIGIBLE", "SUBMITTED", "SETTLED"].includes(s));
  return (
    <ul className={styles.pipeline}>
      {stages.map((s) => (
        <li key={s}>
          <Link href={`/app/outcomes?stage=${STAGE_FILTER[s]}${campaignId ? `&campaign=${campaignId}` : ""}`}>
            <i data-tone={STAGE_TONE[s]} aria-hidden="true" />
            <span>{STAGE_LABEL[s]}</span>
            <b className="tnum">{counts[s]}</b>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function HoldList({ rows, campaigns }: { rows: OutcomeRow[]; campaigns: CampaignView[] }) {
  const names = nameMap(campaigns);
  return (
    <ul className={styles.holdList}>
      {rows.map((r) => (
        <li key={r.id} className={styles.holdItem}>
          <div className={styles.holdTop}>
            <div className={styles.cellTitle}>
              <span>
                Outcome <span className="mono">{r.id.slice(0, 8)}</span>
              </span>
              <small>{names.get(r.campaignId)}</small>
            </div>
            <strong className="tnum">{formatDuration(r.holdRemainingMs ?? 0)}</strong>
          </div>
          <Rail steps={RAIL.map((s) => s.label)} current={railIndex(r.stage)} size="sm" />
        </li>
      ))}
    </ul>
  );
}

export function ActivityTimeline({ items, now, campaigns }: { items: ActivityView[]; now: number; campaigns: CampaignView[] }) {
  const names = nameMap(campaigns);
  return (
    <ol className={styles.timeline}>
      {items.map((a) => (
        <li key={a.id}>
          <i data-tone={activityTone(a.action)} aria-hidden="true" />
          <div>
            <b>{activityLabel(a.action)}</b>
            <small>
              {a.targetType === "campaign" && a.targetId && names.get(a.targetId)
                ? names.get(a.targetId)
                : `${a.actorType === "USER" ? "By a workspace member" : "By Thesma"}${a.targetType ? ` · ${a.targetType.replace(/_/g, " ")}` : ""}`}
            </small>
          </div>
          <time dateTime={a.createdAt}>{formatRelative(a.createdAt, now)}</time>
        </li>
      ))}
    </ol>
  );
}
