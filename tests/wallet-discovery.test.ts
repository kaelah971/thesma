import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_MAINNET_CHAIN_ID, ARC_USDC_DEFAULT } from "@/server/chain/arc";
import { THESMA_VAULT_ADDRESS } from "@/lib/proof";
import {
  chainHex,
  connectWallet,
  discoverWallet,
  findMetaMask6963,
  getWalletState,
  pickInjectedWallet,
  switchToNetwork,
  truncateAddress,
  type EIP6963Detail,
  type InjectedProvider,
} from "@/lib/wallet";

/**
 * Injected-wallet discovery (production funding repro, generalized).
 *
 * The live failure: MetaMask visibly installed yet funding claimed
 * "MetaMask is not installed" — the old check read only `window.ethereum`
 * at click time. These tests pin the replacement contract: EIP-6963,
 * multi-provider arrays, delayed injection, and truthful wallet states.
 * Providers are pure mocks; no signature, broadcast, key or DB access.
 */

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
const CHAIN_5042 = "0x13b2";

function mockProvider(over: Partial<InjectedProvider> & { onRequest?: (m: string) => unknown } = {}): InjectedProvider & { calls: string[] } {
  const calls: string[] = [];
  const { onRequest, ...rest } = over;
  const p = {
    calls,
    ...rest,
    async request({ method }: { method: string; params?: unknown }) {
      calls.push(method);
      if (onRequest) return onRequest(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
      if (method === "eth_chainId") return CHAIN_5042;
      return null;
    },
  } as InjectedProvider & { calls: string[] };
  return p;
}

function eip6963Detail(rdns: string, provider: InjectedProvider, name?: string): EIP6963Detail {
  return { info: { uuid: `${rdns}-uuid`, name: name ?? rdns, icon: "", rdns }, provider };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("repo chain truth", () => {
  it("Arc Mainnet is 5042", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(5042);
    expect(chainHex(5042)).toBe("0x13b2");
  });

  it("canonical USDC and vault match funding truth", () => {
    expect(ARC_USDC_DEFAULT).toBe("0x3600000000000000000000000000000000000000");
    expect(THESMA_VAULT_ADDRESS).toBe("0x0fA826256a58F19Ad24Fc9384d81D313f2266F79");
  });
});

describe("pickInjectedWallet (synchronous)", () => {
  it("no injected provider → null (NOT_INSTALLED)", () => {
    vi.stubGlobal("window", {});
    expect(pickInjectedWallet()).toBeNull();
  });

  it("no window (SSR) → null", () => {
    expect(pickInjectedWallet()).toBeNull();
  });

  it("window.ethereum MetaMask → detected", () => {
    const eth = mockProvider({ isMetaMask: true });
    vi.stubGlobal("window", { ethereum: eth });
    const found = pickInjectedWallet();
    expect(found?.isMetaMask).toBe(true);
    expect(found?.name).toBe("MetaMask");
    expect(found?.source).toBe("injected");
  });

  it("multi-provider array with MetaMask not first → MetaMask detected", () => {
    const other = mockProvider({});
    const meta = mockProvider({ isMetaMask: true });
    const third = mockProvider({});
    vi.stubGlobal("window", { ethereum: { request: async () => null, providers: [other, meta, third] } });
    const found = pickInjectedWallet();
    expect(found?.provider).toBe(meta);
    expect(found?.isMetaMask).toBe(true);
    expect(found?.source).toBe("providers");
  });

  it("non-MetaMask single provider is labeled truthfully, never as MetaMask", () => {
    const eth = mockProvider({});
    vi.stubGlobal("window", { ethereum: eth });
    const found = pickInjectedWallet();
    expect(found?.isMetaMask).toBe(false);
    expect(found?.name).not.toBe("MetaMask");
  });
});

describe("EIP-6963 discovery", () => {
  it("MetaMask announcement → detected", () => {
    const meta = mockProvider({ isMetaMask: true });
    const details = [eip6963Detail("com.other", mockProvider({})), eip6963Detail("io.metamask", meta, "MetaMask")];
    expect(findMetaMask6963(details)?.provider).toBe(meta);
  });

  it("announcement round-trip resolves even when window.ethereum is absent", async () => {
    const listeners = new Map<string, Set<EventListener>>();
    const win = {
      addEventListener: (t: string, l: EventListener) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
      },
      removeEventListener: (t: string, l: EventListener) => listeners.get(t)?.delete(l),
      dispatchEvent: (e: Event) => {
        if (e.type === "eip6963:requestProvider") {
          const meta = mockProvider({ isMetaMask: true });
          const announce = new CustomEvent("eip6963:announceProvider", {
            detail: eip6963Detail("io.metamask", meta, "MetaMask"),
          });
          listeners.get("eip6963:announceProvider")?.forEach((l) => l(announce));
        }
        return true;
      },
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("CustomEvent", CustomEvent);
    vi.stubGlobal("Event", Event);
    const found = await discoverWallet(50);
    expect(found?.isMetaMask).toBe(true);
    expect(found?.source).toBe("eip6963");
  });

  it("delayed injection → late re-check succeeds", async () => {
    const win: Record<string, unknown> = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    vi.stubGlobal("window", win);
    const meta = mockProvider({ isMetaMask: true });
    setTimeout(() => {
      (win as Record<string, unknown>).ethereum = meta;
    }, 10);
    const found = await discoverWallet(120);
    expect(found?.isMetaMask).toBe(true);
  });

  it("nothing anywhere → null", async () => {
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    });
    await expect(discoverWallet(10)).resolves.toBeNull();
  });
});

describe("wallet states", () => {
  it("installed but disconnected → DISCONNECTED, not NOT_INSTALLED", async () => {
    const p = mockProvider({ onRequest: (m) => (m === "eth_accounts" ? [] : CHAIN_5042) });
    const st = await getWalletState(p, 5042);
    expect(st.state).toBe("DISCONNECTED");
    expect(st.account).toBeNull();
  });

  it("eth_requestAccounts success → connected account", async () => {
    const p = mockProvider({});
    const res = await connectWallet(p);
    expect(res).toEqual({ account: ACCOUNT });
    expect(p.calls).toContain("eth_requestAccounts");
    expect(p.calls).not.toContain("eth_sendTransaction");
  });

  it("user rejection (4001) → USER_REJECTED", async () => {
    const p = mockProvider({
      onRequest: (m) => {
        if (m === "eth_requestAccounts") throw Object.assign(new Error("User rejected the request"), { code: 4001 });
        return [ACCOUNT];
      },
    });
    await expect(connectWallet(p)).resolves.toEqual({ failure: "USER_REJECTED" });
  });

  it("wrong chain → WRONG_NETWORK with observed chain", async () => {
    const p = mockProvider({ onRequest: (m) => (m === "eth_accounts" ? [ACCOUNT] : "0x1") });
    const st = await getWalletState(p, 5042);
    expect(st.state).toBe("WRONG_NETWORK");
    expect(st.chainId).toBe("0x1");
    expect(st.account).toBe(ACCOUNT);
  });

  it("Arc chain 5042 with account → READY", async () => {
    const p = mockProvider({});
    const st = await getWalletState(p, 5042);
    expect(st).toMatchObject({ state: "READY", account: ACCOUNT, chainId: CHAIN_5042 });
  });

  it("switch request succeeds without any transaction", async () => {
    const p = mockProvider({ onRequest: () => null });
    await expect(switchToNetwork(p, 5042)).resolves.toEqual({ switched: true });
    expect(p.calls).toEqual(["wallet_switchEthereumChain"]);
  });

  it("unknown chain (4902) → CHAIN_NOT_ADDED, never invents RPC URLs", async () => {
    const p = mockProvider({
      onRequest: (m) => {
        if (m === "wallet_switchEthereumChain") throw Object.assign(new Error("Unknown chain"), { code: 4902 });
        return null;
      },
    });
    await expect(switchToNetwork(p, 5042)).resolves.toEqual({ failure: "CHAIN_NOT_ADDED" });
    expect(p.calls).not.toContain("wallet_addEthereumChain");
    expect(p.calls).not.toContain("eth_sendTransaction");
  });

  it("discovery and state probes never send transactions", async () => {
    const p = mockProvider({});
    vi.stubGlobal("window", { ethereum: p });
    expect(pickInjectedWallet()).not.toBeNull();
    await getWalletState(p, 5042);
    await connectWallet(p);
    for (const c of p.calls) {
      expect(c).not.toMatch(/eth_sendTransaction|eth_sign/);
    }
  });
});

describe("display safety", () => {
  it("truncateAddress shortens without leaking full value in UI strings", () => {
    const t = truncateAddress(ACCOUNT);
    expect(t).not.toBe(ACCOUNT);
    expect(t).toContain(ACCOUNT.slice(0, 6));
    expect(t).toContain(ACCOUNT.slice(-4));
    expect(truncateAddress(null)).toBe("—");
  });
});
