"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getJson, postJson } from "@/lib/api";
import {
  connectWallet,
  discoverWallet,
  getWalletState,
  switchToNetwork,
  truncateAddress,
  type DiscoveredWallet,
  type InjectedProvider,
} from "@/lib/wallet";

type Purpose = "create-campaign" | "approve-usdc" | "fund-campaign";

interface FundingAction {
  purpose: Purpose;
  chainId: number;
  to: string;
  data: string;
  value: string;
  expectedSender: string;
  expectedAmountMicroUsdc?: string;
}

interface ResumeData {
  actions: FundingAction[];
  campaignKey: string;
  policyHash: string;
  completed: Purpose[];
  confirmReady: boolean;
  funding: { status: string; expectedAmountMicroUsdc: string };
}

interface IntentData extends ResumeData {
  campaign: { id: string; state: string };
}

const STEP_LABEL: Record<Purpose, string> = {
  "create-campaign": "Register campaign",
  "approve-usdc": "Approve USDC",
  "fund-campaign": "Fund campaign",
};

const HASH_FIELD: Record<Purpose, "createTxHash" | "approveTxHash" | "fundingTxHash"> = {
  "create-campaign": "createTxHash",
  "approve-usdc": "approveTxHash",
  "fund-campaign": "fundingTxHash",
};

function fmtMicro(raw: string): string {
  try {
    const v = BigInt(raw);
    const whole = v / 1_000_000n;
    const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return raw;
  }
}

function providerName(w: DiscoveredWallet | null): string {
  return w?.name ?? "your wallet";
}

type Phase =
  | "idle"
  | "working"
  | "preflight"
  | "signing"
  | "done"
  | "error";

/**
 * Owner-only guided funding flow. Executes ONLY the unsigned actions returned
 * by the backend, one MetaMask confirmation at a time, waiting for each
 * receipt before continuing. Never retries a rejected, reverted, unknown or
 * ambiguous transaction.
 */
export function CampaignFunding({
  campaignId,
  version,
  state,
  isOwner,
  fundingStatus,
  expectedAmountMicro,
  expectedSender,
  chainId,
}: {
  campaignId: string;
  version: number;
  state: string;
  isOwner: boolean;
  fundingStatus: string | null;
  expectedAmountMicro: string | null;
  expectedSender: string | null;
  chainId: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [wallet, setWallet] = useState<DiscoveredWallet | null>(null);
  const [needsSwitch, setNeedsSwitch] = useState(false);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [actions, setActions] = useState<FundingAction[]>([]);
  const [completed, setCompleted] = useState<Purpose[]>([]);
  const [activeStep, setActiveStep] = useState<Purpose | null>(null);
  const [lastHash, setLastHash] = useState<string | null>(null);

  if (!isOwner) return null;
  if (state === "LIVE" || fundingStatus === "CONFIRMED") return null;
  if (state !== "APPROVED" && state !== "FUNDING") return null;

  const chainHex = `0x${chainId.toString(16)}`;
  const chainName = chainId === 5042 ? "Arc Mainnet" : `Chain ${chainId}`;
  const resumable = fundingStatus === "PREPARED" || fundingStatus === "SUBMITTED" || fundingStatus === "AMBIGUOUS";
  const cta = fundingStatus === "FAILED" ? "Prepare fresh intent" : resumable ? "Continue funding" : "Fund campaign";

  function fail(message: string) {
    setError(message);
    setPhase("error");
    setActiveStep(null);
  }

  async function loadActions(): Promise<ResumeData> {
    // Fresh campaign: prepare the intent first. In-flight: resume it.
    if (!resumable && fundingStatus !== "FAILED") {
      const created = await postJson<IntentData>(`/api/campaigns/${campaignId}/funding-intent`, {
        expectedVersion: version,
      });
      if (created.ok) return created.data;
      // A prepared flow may already exist (e.g. reload after intent) — resume instead.
    }
    const resumed = await getJson<ResumeData>(
      `/api/campaigns/${campaignId}/funding/actions?expectedVersion=${version}`,
    );
    if (!resumed.ok) throw new Error(resumed.error);
    return resumed.data;
  }

  async function begin() {
    setError(null);
    setNote(null);
    setNeedsSwitch(false);
    setNeedsRegistration(false);
    // No registered wallet is its own state — never mislabeled as "wrong account".
    // No provider touch, no intent preparation, no transaction.
    if (!expectedSender) {
      setNeedsRegistration(true);
      fail("Register a company wallet before funding this campaign.");
      return;
    }
    setPhase("working");
    setNote("Looking for an injected wallet…");
    try {
      // Re-discovered on every attempt: never cache "not installed".
      // EIP-6963 + multi-provider aware, tolerant of delayed injection.
      const found = await discoverWallet();
      if (!found) {
        throw new Error(
          "MetaMask or another compatible wallet was not detected. Install MetaMask (or another injected wallet), unlock it, then try again.",
        );
      }
      setWallet(found);
      const provider = found.provider;
      // Silent probe first — already-connected wallets skip the prompt entirely.
      const probe = await getWalletState(provider, chainId);
      let connected: string | null = null;
      if (probe.state === "READY" || probe.state === "WRONG_NETWORK") {
        connected = probe.account;
      } else {
        setNote(`Waiting for ${found.name} — approve the connection request.`);
        const res = await connectWallet(provider);
        if ("failure" in res) {
          if (res.failure === "USER_REJECTED") {
            throw new Error("Connection request was rejected in the wallet. Click Fund campaign to try again.");
          }
          if (res.failure === "NO_ACCOUNT") {
            throw new Error(`${found.name} returned no account. Unlock it and try again.`);
          }
          throw new Error(`${found.name} could not connect. Unlock it and try again.`);
        }
        connected = res.account;
      }
      if (!connected) throw new Error("No account returned by the wallet.");
      if (!expectedSender || connected.toLowerCase() !== expectedSender.toLowerCase()) {
        throw new Error(
          `Wrong account. Connected ${truncateAddress(connected)}, but this campaign must be funded from ${expectedSender ? truncateAddress(expectedSender) : "the registered company wallet"}. Switch accounts in ${found.name} and try again.`,
        );
      }
      const currentChain = (await provider.request({ method: "eth_chainId" }).catch(() => null)) as string | null;
      if (!currentChain || currentChain.toLowerCase() !== chainHex.toLowerCase()) {
        setNeedsSwitch(true);
        throw new Error(
          `${found.name} is on ${currentChain ?? "an unknown network"} — switch to ${chainName} (${chainHex}) to continue.`,
        );
      }
      const data = await loadActions();
      if (data.confirmReady || data.actions.length === 0) {
        // Nothing left to sign: move straight to server reconciliation.
        await reconcile();
        return;
      }
      setAccount(connected);
      setActions(data.actions);
      setCompleted(data.completed);
      setPhase("preflight");
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not start the funding flow.");
    }
  }

  async function recordHash(purpose: Purpose, hash: string): Promise<boolean> {
    const res = await postJson(`/api/campaigns/${campaignId}/funding-submitted`, {
      expectedVersion: version,
      [HASH_FIELD[purpose]]: hash,
    });
    if (!res.ok) {
      fail(`Transaction ${hash} was submitted onchain but the backend refused to record it: ${res.error}. Do NOT resend — report this hash.`);
      return false;
    }
    return true;
  }

  async function switchChain() {
    if (!wallet) return fail("Wallet disconnected. Start again.");
    setError(null);
    setNeedsSwitch(false);
    setPhase("working");
    setNote(`Asking ${wallet.name} to switch to ${chainName}…`);
    const res = await switchToNetwork(wallet.provider, chainId);
    if ("failure" in res) {
      if (res.failure === "USER_REJECTED") {
        return fail("Network switch was rejected in the wallet. Switch to Arc Mainnet manually and retry.");
      }
      if (res.failure === "CHAIN_NOT_ADDED") {
        setNeedsSwitch(true);
        return fail(
          `Your wallet does not know ${chainName} (${chainHex}) yet. Add Arc Mainnet (chain 5042) in ${wallet.name}, then retry.`,
        );
      }
      return fail(`${wallet.name} could not switch networks. Switch to ${chainName} manually and retry.`);
    }
    await begin();
  }

  async function waitForReceipt(provider: InjectedProvider, hash: string): Promise<"success" | "reverted" | "unknown"> {
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const receipt = (await provider
        .request({ method: "eth_getTransactionReceipt", params: [hash] })
        .catch(() => null)) as { status?: string } | null;
      if (!receipt) continue;
      if (receipt.status === "0x1" || receipt.status === "1") return "success";
      return "reverted";
    }
    return "unknown";
  }

  async function execute() {
    if (!account) return fail("Wallet disconnected. Start again.");
    const provider = wallet?.provider;
    if (!provider) return fail("Wallet disconnected. Start again.");
    setError(null);
    setPhase("signing");
    for (const action of actions) {
      if (action.chainId !== chainId) {
        return fail(`Backend action targets chain ${action.chainId}, expected ${chainId}. Stopped before signing.`);
      }
      if (action.expectedSender.toLowerCase() !== account.toLowerCase()) {
        return fail("Backend action expects a different sender. Stopped before signing.");
      }
      setActiveStep(action.purpose);
      let hash: string;
      try {
        hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: action.to, value: "0x0", data: action.data }],
        })) as string;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/rejected|denied|user/i.test(msg)) {
          return fail(`You rejected the "${STEP_LABEL[action.purpose]}" confirmation in ${providerName(wallet)}. Nothing was broadcast for that step — click ${resumable ? "Continue funding" : "Fund campaign"} to retry when ready.`);
        }
        return fail(`Wallet refused to send "${STEP_LABEL[action.purpose]}": ${msg}. Nothing was recorded — safe to retry.`);
      }
      setLastHash(hash);
      const outcome = await waitForReceipt(provider, hash);
      if (outcome === "reverted") {
        await recordHash(action.purpose, hash);
        return fail(`Transaction ${hash} reverted onchain. It has been recorded so it will never be silently retried. Funding is stopped — report this hash.`);
      }
      if (outcome === "unknown") {
        await recordHash(action.purpose, hash);
        return fail(`Transaction ${hash} has no receipt yet. It has been recorded — do NOT resend it. Wait, then reload and Continue funding to let the app reconcile.`);
      }
      const recorded = await recordHash(action.purpose, hash);
      if (!recorded) return;
      setCompleted((c) => [...c, action.purpose]);
    }
    setActiveStep(null);
    await reconcile();
  }

  async function reconcile() {
    setPhase("working");
    setNote("Reconciling against Arc — the server reads the chain independently.");
    const res = await postJson<{ funding: { status: string } }>(`/api/campaigns/${campaignId}/funding-confirm`, {
      expectedVersion: version,
    });
    if (!res.ok) {
      setPhase("error");
      setError(`Reconciliation says: ${res.error}. No further transaction was sent. Reload to check status.`);
      router.refresh();
      return;
    }
    if (res.data.funding.status === "CONFIRMED") {
      setPhase("done");
    } else {
      setPhase("error");
      setError(`Funding is ${res.data.funding.status}, not confirmed. No further transaction was sent. Reload to check status.`);
    }
    router.refresh();
  }

  if (phase === "done") {
    return (
      <div role="status" style={{ display: "grid", gap: 8 }}>
        <p style={{ fontWeight: 700 }}>Campaign funded</p>
        <p style={{ fontSize: 14 }}>
          {expectedAmountMicro ? `${fmtMicro(expectedAmountMicro)} USDC` : "The full budget"} confirmed on Arc. Campaign
          is live.
        </p>
      </div>
    );
  }

  const vaultDestination = actions.find((a) => a.purpose === "fund-campaign")?.to ?? null;

  if (phase === "preflight") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <p style={{ fontSize: 14 }}>
          Amount to fund: <strong>{expectedAmountMicro ? `${fmtMicro(expectedAmountMicro)} USDC` : "—"}</strong>
        </p>
        <p style={{ fontSize: 14 }}>Network: <strong>{chainName}</strong></p>
        <p style={{ fontSize: 14 }}>Asset: <strong>USDC</strong></p>
        {vaultDestination && (
          <p style={{ fontSize: 14 }}>Destination: <span className="mono" title={vaultDestination}>{truncateAddress(vaultDestination)}</span> (Thesma vault)</p>
        )}
        <p style={{ fontSize: 14 }}>Connected wallet: <span className="mono" title={account ?? ""}>{truncateAddress(account)}</span>{wallet ? ` (${wallet.name})` : ""}</p>
        <p style={{ fontSize: 14 }}>Expected company wallet: <span className="mono" title={expectedSender ?? ""}>{truncateAddress(expectedSender)}</span></p>
        <p style={{ fontSize: 13, opacity: 0.8 }}>{actions.length} wallet confirmation{actions.length === 1 ? "" : "s"} may be required — one at a time.</p>
        <ol style={{ fontSize: 14, margin: 0, paddingLeft: 20 }}>
          {actions.map((a) => (
            <li key={a.purpose}>{STEP_LABEL[a.purpose]}{a.expectedAmountMicroUsdc ? ` — ${fmtMicro(a.expectedAmountMicroUsdc)} USDC` : ""}</li>
          ))}
        </ol>
        <button type="button" className="btn btn-primary" onClick={execute}>
          Start signing ({actions.length} confirmation{actions.length === 1 ? "" : "s"})
        </button>
        {completed.length > 0 && (
          <p style={{ fontSize: 13 }}>Already complete: {completed.map((c) => STEP_LABEL[c]).join(", ")}</p>
        )}
      </div>
    );
  }

  const steps: Purpose[] = ["create-campaign", "approve-usdc", "fund-campaign"];
  const inFlight = phase === "signing" || phase === "working";

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {(phase === "signing" || phase === "working") && (
        <ol style={{ fontSize: 14, margin: 0, paddingLeft: 20 }}>
          {steps.map((s) => (
            <li key={s}>
              {completed.includes(s) ? "✓ " : activeStep === s ? "→ " : "○ "}
              {STEP_LABEL[s]}
            </li>
          ))}
        </ol>
      )}
      {lastHash && (phase === "signing" || phase === "working") && (
        <p style={{ fontSize: 13 }}>Latest transaction: <span className="mono">{lastHash}</span></p>
      )}
      {phase === "idle" && (
        <button type="button" className="btn btn-primary" onClick={begin}>
          {cta}
        </button>
      )}
      {phase === "working" && <p style={{ fontSize: 14 }}>{note ?? "Working…"}</p>}
      {phase === "error" && error && (
        <p className="form-error" role="alert" style={{ fontSize: 14 }}>{error}</p>
      )}
      {phase === "error" && needsSwitch && wallet && (
        <button type="button" className="btn btn-primary" onClick={switchChain}>
          Switch to {chainName} in {wallet.name}
        </button>
      )}
      {phase === "error" && needsRegistration && (
        <Link href="/app/settings" className="btn btn-primary">
          Register wallet in Settings
        </Link>
      )}
      {phase === "error" && (
        <button type="button" className="btn btn-ghost" onClick={() => { setPhase("idle"); setError(null); setNeedsSwitch(false); setNeedsRegistration(false); }}>
          Back
        </button>
      )}
    </div>
  );
}
