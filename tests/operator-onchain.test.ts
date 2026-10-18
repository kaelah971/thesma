import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";
import { buildApprovalIntent, OPERATOR_VAULT_ABI, VAULT_ABI } from "@/server/chain/arc";

const VAULT = "0x0000000000000000000000000000000000000a11" as Address;
const OUTCOME = ("0x" + "11".repeat(32)) as Hex;
const PROOF = ("0x" + "22".repeat(32)) as Hex;
const KEY = ("0x" + "33".repeat(32)) as Hex;
const RECIPIENT = "0x0000000000000000000000000000000000000b22" as Address;

const ARGS = [KEY, OUTCOME, RECIPIENT, 4_000_000n, PROOF, 1_000n, 2_000n, ("0x" + "ab".repeat(65)) as Hex] as const;

describe("operator vault ABI binding", () => {
  it("encodes distinct selectors per path so a label can never misroute", () => {
    const legacy = encodeFunctionData({ abi: VAULT_ABI, functionName: "payoutVerifiedOutcome", args: [...ARGS] });
    const autonomous = encodeFunctionData({ abi: OPERATOR_VAULT_ABI, functionName: "payoutAutonomous", args: [...ARGS] });
    const approved = encodeFunctionData({ abi: OPERATOR_VAULT_ABI, functionName: "payoutApproved", args: [...ARGS] });
    expect(legacy).not.toBe(autonomous);
    expect(legacy).not.toBe(approved);
    expect(autonomous).not.toBe(approved);
    expect(decodeFunctionData({ abi: OPERATOR_VAULT_ABI, data: autonomous }).functionName).toBe("payoutAutonomous");
    expect(decodeFunctionData({ abi: OPERATOR_VAULT_ABI, data: approved }).functionName).toBe("payoutApproved");
  });

  it("has no generic payout entrypoint to bypass policy", () => {
    const fns = OPERATOR_VAULT_ABI.filter((e) => e.type === "function").map((e) => e.name);
    expect(fns).not.toContain("payoutVerifiedOutcome");
    expect(fns).toEqual(
      expect.arrayContaining(["payoutAutonomous", "payoutApproved", "approveObligation", "setOperatorPolicy", "getOperatorPolicy"]),
    );
  });

  it("builds an exact unsigned approval intent the owner can sign (never signs)", () => {
    const intent = buildApprovalIntent({
      vault: VAULT,
      campaignKey: KEY,
      outcomeId: OUTCOME,
      recipient: RECIPIENT,
      amountMicroUsdc: 14_000_000n,
      proofHash: PROOF,
    });
    expect(intent.to).toBe(VAULT);
    expect(intent.value).toBe("0");
    const decoded = decodeFunctionData({ abi: OPERATOR_VAULT_ABI, data: intent.data });
    expect(decoded.functionName).toBe("approveObligation");
    expect(decoded.args).toEqual([KEY, OUTCOME, RECIPIENT, 14_000_000n, PROOF]);
  });

  it("refuses non-positive approval amounts", () => {
    expect(() =>
      buildApprovalIntent({ vault: VAULT, campaignKey: KEY, outcomeId: OUTCOME, recipient: RECIPIENT, amountMicroUsdc: 0n, proofHash: PROOF }),
    ).toThrow();
  });
});
