/**
 * Money primitives for the USDC domain.
 *
 * RULES (non-negotiable for all future slices):
 * - Never use JS floating point for money.
 * - USDC-domain amounts are exact integers in micro-USDC
 *   (1 USDC = 1_000_000 micro-USDC), compatible with 6-decimal USDC.
 * - Over the wire and in rulesJson, represent micro amounts as decimal
 *   strings (safe for JSON + Postgres bigint). Inside calculations, use bigint.
 * - No float parsing (no parseFloat, no * 1e6 on floats).
 */

export const MICRO_USDC_PER_USDC = 1_000_000n;

/** "2.50" -> 2500000n. Accepts 0-6 decimals, rejects floats/negatives/surplus precision. */
export function usdcToMicro(input: string): bigint {
  const normalized = input.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid USDC amount: ${input}`);
  }
  const whole = BigInt(match[1]);
  const frac = (match[2] ?? "").padEnd(6, "0");
  return whole * MICRO_USDC_PER_USDC + BigInt(frac === "" ? "0" : frac);
}

/** 2500000n -> "2.5". Trims trailing zeros, never emits exponents. */
export function microToUsdcString(micro: bigint): string {
  if (micro < 0n) throw new Error("Micro-USDC amount cannot be negative");
  const whole = micro / MICRO_USDC_PER_USDC;
  const frac = micro % MICRO_USDC_PER_USDC;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** Decimal-string micro amount validation (for Zod + rulesJson boundaries). */
export function isMicroUsdcString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export function parseMicroUsdcString(value: string): bigint {
  if (!isMicroUsdcString(value)) throw new Error(`Invalid micro-USDC: ${value}`);
  return BigInt(value);
}

export function addMicro(a: bigint, b: bigint): bigint {
  if (a < 0n || b < 0n) throw new Error("Micro-USDC amounts cannot be negative");
  return a + b;
}
