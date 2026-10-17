import { encodeAbiParameters, getAddress, keccak256, stringToHex, type Hex } from "viem";

/**
 * Canonical campaignKey + policyHash derivation (S2).
 *
 * These bindings are financial: the vault stores policyHash immutably at
 * creation, and the backend refuses to confirm funding unless the onchain
 * record matches a recomputation. Determinism rules:
 * - ABI encoding everywhere (no string concatenation, no delimiter games).
 * - Rule objects are hashed from stable JSON (sorted keys, no whitespace).
 * - Never JSON.stringify an unordered object and call that financial hashing.
 *
 * CANONICAL ALGORITHMS (v1 — changing these requires a version bump):
 *
 *   campaignKey = keccak256(abi.encode(
 *     "thesma:campaign",  // string: namespace domain separator
 *     campaignId,         // string: database campaign UUID
 *     policyVersion       // uint256: approved policy version
 *   ))
 *
 *   rulesHash(rules) = keccak256(stableJson(rules))
 *
 *   policyHash = keccak256(abi.encode(
 *     "thesma:policy:v1", // string: algorithm version tag
 *     campaignId,                 // string
 *     policyVersion,              // uint256
 *     targetOutcomeCount,         // uint256
 *     budgetMicroUsdc,            // uint256
 *     bountyFloorMicroUsdc,       // uint256
 *     bountyCeilingMicroUsdc,     // uint256
 *     minQualifyingPurchaseMicroUsdc, // uint256
 *     deadlineUnix,               // uint256, seconds
 *     marketVisibility,           // string "PUBLIC" | "PRIVATE"
 *     refundHoldSeconds,          // uint256
 *     allowedRulesHash,           // bytes32
 *     escalationRulesHash,        // bytes32
 *     companyWallet               // address (owner funding address)
 *   ))
 *
 * Property: approved version N always hashes identically; any field change
 * or version bump changes both bindings.
 */

export type Hex32 = `0x${string}`;

/** Deterministic JSON: sorted object keys, compact, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number in rules JSON");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  throw new Error(`Unserializable rules value: ${typeof value}`);
}

export function hashRulesJson(rules: Record<string, unknown>): Hex32 {
  return keccak256(stringToHex(stableStringify(rules)));
}

export function campaignKeyFor(campaignId: string, policyVersion: number): Hex32 {
  if (!campaignId) throw new Error("campaignId is required");
  if (!Number.isInteger(policyVersion) || policyVersion < 1) throw new Error("policyVersion must be a positive integer");
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "uint256" }],
      ["thesma:campaign", campaignId, BigInt(policyVersion)],
    ),
  );
}

export interface PolicyHashInput {
  campaignId: string;
  policyVersion: number;
  targetOutcomeCount: number;
  budgetMicroUsdc: bigint;
  bountyFloorMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint;
  minQualifyingPurchaseMicroUsdc: bigint;
  deadline: Date;
  marketVisibility: string;
  refundHoldSeconds: number;
  allowedPartnerRules: Record<string, unknown>;
  escalationRules: Record<string, unknown>;
  companyWallet: string;
}

export function policyHashFor(input: PolicyHashInput): Hex32 {
  const normalizedWallet = getAddress(input.companyWallet); // throws on malformed
  const deadlineUnix = BigInt(Math.floor(input.deadline.getTime() / 1000));
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "string" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
      ],
      [
        "thesma:policy:v1",
        input.campaignId,
        BigInt(input.policyVersion),
        BigInt(input.targetOutcomeCount),
        input.budgetMicroUsdc,
        input.bountyFloorMicroUsdc,
        input.bountyCeilingMicroUsdc,
        input.minQualifyingPurchaseMicroUsdc,
        deadlineUnix,
        input.marketVisibility,
        BigInt(input.refundHoldSeconds),
        hashRulesJson(input.allowedPartnerRules),
        hashRulesJson(input.escalationRules),
        normalizedWallet as Hex,
      ],
    ),
  );
}
