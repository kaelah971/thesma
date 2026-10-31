import type { Metadata } from "next";
import { CreateWorkspaceForm } from "@/components/app/CreateWorkspaceForm";
import { Card, Facts, PageHeader, Pill } from "@/components/app/ui";
import styles from "@/components/app/app.module.css";
import { shortHash } from "@/lib/format";
import { CompanyWalletRegistration } from "@/components/app/CompanyWalletRegistration";
import { arcConfigFromEnv } from "@/server/chain/arc";
import { selectWorkspace } from "../actions";
import { getAppSession } from "../data";

export const metadata: Metadata = { title: "Settings" };

const ROLE: Record<string, string> = {
  ORGANIZATION_OWNER: "Owner",
  ORGANIZATION_MEMBER: "Member",
  PARTNER: "Partner",
};

function chainReady() {
  try {
    const cfg = arcConfigFromEnv();
    return { configured: !!cfg, vault: !!cfg?.vaultAddress };
  } catch {
    return { configured: false, vault: false };
  }
}

export default async function SettingsPage() {
  const session = await getAppSession();
  if (session.kind !== "ok") return null;
  const chain = chainReady();
  const current = session.current;

  return (
    <>
      <PageHeader title="Settings" description="Workspace, account and settlement readiness." />
      <div className={styles.grid2}>
        <div className={styles.stack}>
          <Card title="Current workspace">
            {current ? (
              <Facts
                items={[
                  { label: "Name", value: current.name },
                  { label: "Your role", value: ROLE[current.role] ?? current.role },
                  { label: "Category", value: current.category ?? "—" },
                  {
                    label: "Company wallet",
                    value: current.companyWallet ? <span className="mono">{shortHash(current.companyWallet, 8, 6)}</span> : "Not registered",
                  },
                ]}
              />
            ) : (
              <p className={styles.muted}>You don&apos;t belong to a workspace yet.</p>
            )}
          </Card>

          <Card title="Your workspaces">
            <ul className={styles.pipeline}>
              {session.workspaces.map((w) => (
                <li key={w.id}>
                  <form action={selectWorkspace}>
                    <input type="hidden" name="workspaceId" value={w.id} />
                    <button
                      type="submit"
                      className="btn btn-quiet"
                      style={{ width: "100%", justifyContent: "space-between", borderRadius: 12 }}
                      disabled={w.id === current?.id}
                    >
                      <span>{w.name}</span>
                      {w.id === current?.id ? <Pill tone="mint">Active</Pill> : <span className={styles.muted}>{ROLE[w.role]}</span>}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Create another workspace">
            <CreateWorkspaceForm compact />
          </Card>
        </div>

        <div className={styles.stack}>
          <Card title="Account">
            <Facts
              columns={1}
              items={[
                { label: "Name", value: session.user.name ?? "—" },
                { label: "Email", value: session.user.email },
              ]}
            />
          </Card>
          <Card title="Settlement readiness">
            <Facts
              columns={1}
              items={[
                { label: "Database", value: <Pill tone="mint">Connected</Pill> },
                { label: "Arc network", value: chain.configured ? <Pill tone="mint">Configured</Pill> : <Pill tone="cream">Not configured</Pill> },
                { label: "Campaign vault", value: chain.vault ? <Pill tone="mint">Configured</Pill> : <Pill tone="cream">Not configured</Pill> },
              ]}
            />
            <p className={styles.muted} style={{ fontSize: 13, marginTop: 12 }}>
              Company wallet — your organization&apos;s address, used to sign and fund campaigns. Campaign vault —
              Thesma&apos;s Arc contract where campaign USDC is deposited. Thesma never holds your wallet keys.
            </p>
          </Card>
          {current && current.role === "ORGANIZATION_OWNER" && (
            <Card title="Company wallet">
              <Facts
                columns={1}
                items={[
                  {
                    label: "Status",
                    value: current.companyWallet ? (
                      <span className="mono">{shortHash(current.companyWallet, 8, 6)}</span>
                    ) : (
                      "Not registered"
                    ),
                  },
                ]}
              />
              <CompanyWalletRegistration workspaceId={current.id} currentWallet={current.companyWallet} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
