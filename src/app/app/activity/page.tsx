import type { Metadata } from "next";
import { ActivityTimeline } from "@/components/app/DataViews";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, EmptyState, PageHeader } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { formatDate } from "@/lib/format";
import type { ActivityView } from "@/lib/readmodel";
import { requireWorkspace } from "../data";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;
  const now = Date.parse(snapshot.generatedAt);

  const days = new Map<string, ActivityView[]>();
  for (const a of snapshot.activity) {
    const key = formatDate(a.createdAt);
    days.set(key, [...(days.get(key) ?? []), a]);
  }

  return (
    <>
      <PageHeader
        eyebrow={snapshot.workspace.name}
        title="Activity"
        description="An append-only record of who did what and when — policy, funding, verification and payout events."
      />
      <Card>
        {snapshot.activity.length ? (
          [...days.entries()].map(([day, items]) => (
            <div key={day}>
              <p className={styles.dayLabel}>{day}</p>
              <ActivityTimeline items={items} now={now} campaigns={snapshot.campaigns} />
            </div>
          ))
        ) : (
          <EmptyState title="No activity yet" body="Events appear here as soon as your workspace takes its first action." />
        )}
      </Card>
    </>
  );
}
