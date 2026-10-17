import type { Metadata } from "next";
import Link from "next/link";
import { OutcomeTable, STAGE_FILTER } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, PageHeader } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { campaignName } from "@/lib/format";
import { outcomeRows } from "@/lib/readmodel";
import { requireWorkspace } from "../data";

export const metadata: Metadata = { title: "Outcomes" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "awaiting", label: "Awaiting verification" },
  { key: "hold", label: "Safety hold" },
  { key: "eligible", label: "Eligible" },
  { key: "settlement", label: "In settlement" },
  { key: "settled", label: "Settled" },
  { key: "rejected", label: "Rejected / failed" },
];

export default async function OutcomesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { stage = "all", campaign } = await searchParams;
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;

  const now = Date.parse(snapshot.generatedAt);
  const scoped = campaign && snapshot.campaigns.some((c) => c.id === campaign) ? campaign : undefined;
  const all = outcomeRows(snapshot, now, scoped);
  const rows = stage === "all" ? all : all.filter((r) => STAGE_FILTER[r.stage] === stage);
  const count = (key: string) => (key === "all" ? all.length : all.filter((r) => STAGE_FILTER[r.stage] === key).length);
  const href = (key: string) => `/app/outcomes?stage=${key}${scoped ? `&campaign=${scoped}` : ""}`;
  const scopedName = scoped ? campaignName(snapshot.campaigns.find((c) => c.id === scoped)?.intentText) : null;

  return (
    <>
      <PageHeader
        eyebrow={snapshot.workspace.name}
        title="Outcomes"
        description="Every customer result, from submitted purchase to settled payout. Verified means the evidence passed — not that anyone was paid."
        actions={
          scoped && (
            <Link href={`/app/outcomes?stage=${stage}`} className="btn btn-quiet btn-sm">
              {scopedName} · clear filter
            </Link>
          )
        }
      />
      <nav className={styles.filters} aria-label="Filter outcomes by stage">
        {FILTERS.map((f) => (
          <Link key={f.key} href={href(f.key)} aria-current={stage === f.key ? "page" : undefined}>
            {f.label} <span className="tnum">{count(f.key)}</span>
          </Link>
        ))}
      </nav>
      <Card>
        {rows.length ? (
          <div style={{ marginTop: -22 }}>
            <OutcomeTable rows={rows} campaigns={snapshot.campaigns} showCampaign={!scoped} />
          </div>
        ) : (
          <EmptyState
            title={all.length ? "Nothing in this stage" : "No outcomes yet"}
            body={
              all.length
                ? "Try another stage to see where outcomes currently sit."
                : "Outcomes appear when a referred customer completes a qualifying purchase on a live campaign."
            }
            action={
              !all.length && (
                <Link href="/app/campaigns" className="btn btn-quiet btn-sm">
                  View campaigns
                </Link>
              )
            }
          />
        )}
      </Card>
    </>
  );
}
