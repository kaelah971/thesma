import { microToUsdcString } from "@/server/domain/money";

/** Exact USDC display from a micro-USDC decimal string or bigint. Never rounds. */
export function formatUsdc(micro: string | bigint | null | undefined): string {
  if (micro === null || micro === undefined) return "—";
  const value = typeof micro === "bigint" ? micro : BigInt(micro);
  const negative = value < 0n;
  const [whole, frac] = microToUsdcString(negative ? -value : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Compact duration: 42m, 3h 12m, 2d 4h. Sub-minute rounds up to 1m. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatHoldSeconds(seconds: number): string {
  if (seconds <= 0) return "No hold";
  return formatDuration(seconds * 1000);
}

export function shortHash(value: string | null | undefined, lead = 6, tail = 4): string {
  if (!value) return "—";
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${tail > 0 ? value.slice(-tail) : ""}`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string | null | undefined): string {
  return iso ? dateFmt.format(new Date(iso)) : "—";
}

/**
 * Calendar-date display for DATE-ONLY business values (campaign deadline).
 *
 * Deadlines are approved as a calendar day (YYYY-MM-DD) and stored as end
 * of that day in UTC (T23:59:59.999Z). Rendering them in the viewer's local
 * timezone shifts the day (e.g. Nov 30 UTC renders as Dec 1 in UTC+1), so
 * date-only values MUST be formatted against UTC — the approved calendar.
 *
 * Do NOT use this for real instants (createdAt, settledAt, verifiedAt):
 * those stay on formatDate/formatDateTime and remain timezone-aware.
 */
const calendarDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatCalendarDate(iso: string | null | undefined): string {
  return iso ? calendarDateFmt.format(new Date(iso)) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : "—";
}

export function formatRelative(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  return `${formatDuration(diff)} ago`;
}

/** Campaigns have no name column: derive a stable label from the owner's intent text. */
export function campaignName(intentText: string | null | undefined): string {
  const text = (intentText ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "Untitled campaign";
  const sentence = text.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, "");
  // Keep the objective, drop the terms: "Acquire 50 paying customers with a budget of…" → "Acquire 50 paying customers".
  const cut = sentence.search(/,|;|\s[—–-]\s|\s(with|by|using|at|for a budget|budget)\s/i);
  const base = cut >= 12 ? sentence.slice(0, cut) : sentence;
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  return label.length > 64 ? `${label.slice(0, 61).trimEnd()}…` : label;
}
