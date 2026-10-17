import styles from "./rail.module.css";

export interface RailProps {
  steps: readonly string[];
  /** Index of the current step. Steps before it are complete. */
  current: number;
  tone?: "mint" | "cream" | "lav" | "blue" | "rose";
  size?: "sm" | "md";
  /** Mark the current step complete as well (e.g. settled). */
  complete?: boolean;
  label?: string;
}

/** The settlement rail: verify → hold → reserve → submit → settle. */
export function Rail({ steps, current, tone = "cream", size = "md", complete = false, label = "Settlement progress" }: RailProps) {
  return (
    <ol className={styles.rail} data-size={size} data-tone={tone} aria-label={label}>
      {steps.map((step, i) => {
        const state = i < current || (complete && i === current) ? "done" : i === current ? "current" : "todo";
        return (
          <li key={step} className={styles.step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className={styles.node} aria-hidden="true" />
            <span className={styles.label}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
