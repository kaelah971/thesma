import type { Metadata } from "next";
import { NewCampaignForm } from "@/components/app/NewCampaignForm";
import { NoWorkspace } from "@/components/app/NoWorkspace";
import { Card, PageHeader } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { requireWorkspace } from "../../data";

export const metadata: Metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  const { snapshot } = await requireWorkspace();
  if (!snapshot) return <NoWorkspace />;

  return (
    <>
      <PageHeader
        back={{ href: "/app/campaigns", label: "Campaigns" }}
        title="Draft a campaign"
        description="Describe the outcome and your hard limits in plain language. Thesma prepares a draft policy — nothing is funded or published until an owner approves it."
      />
      <div className={styles.grid2}>
        <Card title="Describe the outcome">
          <NewCampaignForm workspaceId={snapshot.workspace.id} />
        </Card>
        <Card title="What Thesma reads" tone="blue">
          <ul className={styles.checks}>
            <li>Target count — “acquire 50 paying customers”</li>
            <li>Budget — “a budget of 5000 USDC”</li>
            <li>Floor — “floor 40 USDC”</li>
            <li>Maximum per outcome — “up to 80 USDC per customer”</li>
            <li>Minimum purchase — “purchases of at least 30 USDC”</li>
            <li>Deadline — an explicit date, e.g. 2026-12-31</li>
          </ul>
          <p className={styles.muted} style={{ fontSize: 13, marginTop: 14 }}>
            Missing fields are listed, never guessed. Relative dates like “next Friday” are not accepted.
          </p>
        </Card>
      </div>
    </>
  );
}
