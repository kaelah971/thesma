import type { Metadata } from "next";
import Link from "next/link";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Project settings" };

export default async function DeveloperSettingsPage() {
  const context = await getDeveloperContext();
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>DEVELOPER PROJECT</div><h1>Settings</h1><p className={styles.pageDesc}>Project identity and integration access for your product.</p></div></header>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>Project</h2></div><dl className={styles.stack}><div><dt>Project name</dt><dd>{context.projectName ?? "Not created yet"}</dd></div><div><dt>Product description</dt><dd>{context.productDescription ?? "Not provided"}</dd></div><div><dt>Project ID</dt><dd className="mono">{context.workspace?.id ?? "Created after project setup"}</dd></div></dl></section>
        <section className={styles.card}><div className={styles.cardHead}><h2>Access</h2></div><p className={styles.pageDesc}>Manage named integrations, prefixes and one-time API keys without exposing plaintext credentials again.</p><Link href="/build/integrations" className="btn btn-primary btn-sm">Manage integrations</Link></section>
      </div>
    </div>
  );
}
