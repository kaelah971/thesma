import type { Metadata } from "next";
import { PayoutTable } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, Kpi, PageHeader } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { formatUsdc } from "@/lib/format";
import { requireWorkspace } from "../data";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage() {
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;

  const sum = (states: string[]) =>
    snapshot.payouts.filter((p) => states.includes(p.state)).reduce((s, p) => s + BigInt(p.amountMicro), 0n);
  const n = (states: string[]) => snapshot.payouts.filter((p) => states.includes(p.state)).length;

  return (
    <>
      <PageHeader
        eyebrow={snapshot.workspace.name}
        title="Payouts"
        description="Partner payouts for verified outcomes. Submitted means broadcast; settled means the chain was reconciled. Open any payout for its receipt."
      />
      <div className={styles.kpis}>
        <Kpi label="Settled" value={formatUsdc(sum(["SETTLED"]))} unit="USDC" tone="mint" hint={`${n(["SETTLED"])} reconciled onchain`} />
        <Kpi label="In flight" value={formatUsdc(sum(["PREPARED", "SUBMITTED"]))} unit="USDC" tone="lav" hint={`${n(["PREPARED", "SUBMITTED"])} prepared or submitted`} />
        <Kpi label="Reconciling" value={String(n(["AMBIGUOUS"]))} tone="cream" hint="Never resent blindly" />
        <Kpi label="Failed · released" value={String(n(["FAILED"]))} tone="blue" hint="Budget returned to available" />
      </div>
      <Card>
        {snapshot.payouts.length ? (
          <div style={{ marginTop: -22 }}>
            <PayoutTable payouts={snapshot.payouts} campaigns={snapshot.campaigns} />
          </div>
        ) : (
          <EmptyState title="No payouts yet" body="A payout is created only after an outcome is verified and its campaign's safety hold has passed." />
        )}
      </Card>
    </>
  );
}
