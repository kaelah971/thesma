import { describe, expect, it } from "vitest";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  arcConfigFromEnv,
} from "@/server/chain/arc";

const MAINNET_ENV = {
  ARC_RPC_URL: "https://arc-mainnet.example/rpc",
  ARC_CHAIN_ID: "5042",
};

const TESTNET_ENV = {
  ARC_NETWORK: "testnet",
  ARC_TESTNET_RPC_URL: "https://canteen-testnet.example/rpc",
  ARC_TESTNET_CHAIN_ID: "5042002",
};

/** Plain fixtures are not full ProcessEnv objects. */
const E = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("dual Arc environments", () => {
  it("pins the known chain IDs", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(5042);
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
  });

  it("resolves mainnet by default with the legacy variables intact", () => {
    const config = arcConfigFromEnv(E({ ...MAINNET_ENV }));
    expect(config?.network).toBe("mainnet");
    expect(config?.environmentLabel).toBe("Arc Mainnet");
    expect(config?.chainId).toBe(5042);
    expect(config?.rpcUrl).toBe(MAINNET_ENV.ARC_RPC_URL);
  });

  it("resolves Canteen testnet only from testnet variables", () => {
    const config = arcConfigFromEnv(E({ ...TESTNET_ENV }));
    expect(config?.network).toBe("testnet");
    expect(config?.environmentLabel).toBe("Canteen Arc Testnet");
    expect(config?.chainId).toBe(5042002);
    expect(config?.rpcUrl).toBe(TESTNET_ENV.ARC_TESTNET_RPC_URL);
  });

  it("defaults the testnet chain when unspecified, but never to mainnet", () => {
    const config = arcConfigFromEnv(E({ ARC_NETWORK: "testnet", ARC_TESTNET_RPC_URL: "https://x.example" }));
    expect(config?.chainId).toBe(5042002);
    expect(config?.chainId).not.toBe(5042);
  });

  it("never lets testnet config report the mainnet chain", () => {
    expect(() => arcConfigFromEnv(E({ ...TESTNET_ENV, ARC_TESTNET_CHAIN_ID: "5042" }))).toThrow();
    expect(() => arcConfigFromEnv(E({ ...TESTNET_ENV, ARC_TESTNET_CHAIN_ID: "1" }))).toThrow();
  });

  it("never lets mainnet config report the testnet chain", () => {
    expect(() => arcConfigFromEnv(E({ ...MAINNET_ENV, ARC_CHAIN_ID: "5042002" }))).toThrow();
  });

  it("fails loudly instead of falling back between environments", () => {
    // Testnet selected but no testnet RPC: must throw, not use ARC_RPC_URL.
    expect(() => arcConfigFromEnv(E({ ARC_NETWORK: "testnet", ...MAINNET_ENV }))).toThrow();
    // Unknown selector: must throw, not default silently.
    expect(() => arcConfigFromEnv(E({ ...MAINNET_ENV, ARC_NETWORK: "staging" }))).toThrow();
  });

  it("keeps testnet identities isolated from mainnet variables", () => {
    const config = arcConfigFromEnv(E({
      ...TESTNET_ENV,
      THESMA_EXECUTOR_ADDRESS: "0x1111111111111111111111111111111111111111",
      THESMA_VERIFIER_ADDRESS: "0x2222222222222222222222222222222222222222",
    }));
    // Mainnet identities must not leak into the testnet config.
    expect(config?.executorAddress).toBeNull();
    expect(config?.verifierAddress).toBeNull();
  });

  it("preserves the unconfigured null contract", () => {
    expect(arcConfigFromEnv(E({}))).toBeNull();
    expect(arcConfigFromEnv(E({ ARC_NETWORK: "mainnet" }))).toBeNull();
  });
});
