import { describe, expect, it } from "vitest";
import {
  addMicro,
  isMicroUsdcString,
  microToUsdcString,
  usdcToMicro,
} from "@/server/domain/money";

describe("money (micro-USDC exact integers, never float)", () => {
  it("converts USDC strings to micro integers without float error", () => {
    expect(usdcToMicro("2")).toBe(2_000_000n);
    expect(usdcToMicro("2.50")).toBe(2_500_000n);
    // Classic float trap: 0.1 + 0.2 !== 0.3 in binary float — exact here.
    expect(usdcToMicro("0.1") + usdcToMicro("0.2")).toBe(usdcToMicro("0.3"));
  });

  it("rejects surplus precision, negatives, and non-numeric input", () => {
    expect(() => usdcToMicro("1.1234567")).toThrow();
    expect(() => usdcToMicro("-1")).toThrow();
    expect(() => usdcToMicro("abc")).toThrow();
    expect(() => usdcToMicro("")).toThrow();
  });

  it("round-trips micro -> USDC string without exponents", () => {
    expect(microToUsdcString(2_500_000n)).toBe("2.5");
    expect(microToUsdcString(2_000_000n)).toBe("2");
    expect(microToUsdcString(1n)).toBe("0.000001");
    expect(() => microToUsdcString(-1n)).toThrow();
  });

  it("validates wire-format micro strings", () => {
    expect(isMicroUsdcString("2500000")).toBe(true);
    expect(isMicroUsdcString("2.5")).toBe(false);
    expect(isMicroUsdcString("-1")).toBe(false);
    expect(isMicroUsdcString(2500000)).toBe(false);
  });

  it("adds without overflow of intent and rejects negatives", () => {
    expect(addMicro(1_000_000n, 2_000_000n)).toBe(3_000_000n);
    expect(() => addMicro(-1n, 1n)).toThrow();
  });
});
