import Link from "next/link";
import type { Tone } from "@/lib/readmodel";
import styles from "./app.module.css";

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className="pill" data-tone={tone === "neutral" ? undefined : tone}>
      {children}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  back,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderText}>
        {back && (
          <Link href={back.href} className={styles.back}>
            ← {back.label}
          </Link>
        )}
        {eyebrow && <p className={styles.pageEyebrow}>{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className={styles.pageDesc}>{description}</p>}
      </div>
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  className,
  tone,
  id,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  tone?: Tone;
  id?: string;
}) {
  return (
    <section id={id} className={`${styles.card} ${className ?? ""}`} data-tone={tone}>
      {(title || action) && (
        <div className={styles.cardHead}>
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, hint, tone }: { label: string; value: string; unit?: string; hint?: React.ReactNode; tone: Tone }) {
  return (
    <div className={styles.kpi} data-tone={tone}>
      <span className={styles.kpiLabel}>
        <i aria-hidden="true" />
        {label}
      </span>
      <span className={styles.kpiValue}>
        <strong className="tnum">{value}</strong>
        {unit && <span>{unit}</span>}
      </span>
      {hint && <span className={styles.kpiHint}>{hint}</span>}
    </div>
  );
}

export function Facts({ items, columns = 2 }: { items: { label: string; value: React.ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={styles.facts} data-cols={columns}>
      {items.map((i) => (
        <div key={i.label}>
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyMark} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function ProgressBar({ value, max, tone = "blue", label }: { value: number; max: number; tone?: Tone; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={styles.progress} data-tone={tone} role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
