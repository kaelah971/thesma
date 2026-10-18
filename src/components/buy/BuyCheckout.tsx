"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";

interface Meta {
  campaignId: string;
  productName: string;
  requiredAmountMicroUsdc: string;
  merchant: string;
  partnerPayoutWallet: string | null;
  chainId: number;
  usdcAddress: string;
}

interface Payment {
  chainId: number;
  token: string;
  to: string;
  data: string;
  value: string;
  expectedPayer: string;
  merchant: string;
  amountMicroUsdc: string;
  checkoutIntentId: string;
  orderId: string;
  expiry: string;
}

interface IntentState {
  id: string;
  orderId: string;
  status: string;
  amountMicroUsdc: string;
  merchant: string;
  payer: string;
  txHash: string | null;
}

interface OutcomeState {
  id: string;
  status: string;
  verifiedAt: string | null;
  holdUntil: string | null;
  rejectionCode: string | null;
}

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

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function eth(): { request(a: { method: string; params?: unknown }): Promise<unknown> } {
  const w = window as unknown as { ethereum?: { request(a: { method: string; params?: unknown }): Promise<unknown> } };
  if (!w.ethereum) throw new Error("MetaMask is not installed in this browser. Install it, then try again.");
  return w.ethereum;
}

const TRANSFER_SELECTOR = "0xa9059cbb";
const BALANCE_SELECTOR = "0x70a08231";

function padded(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Decode a canonical ERC-20 transfer calldata; throws on anything else. */
function decodeTransfer(data: string): { to: string; amount: bigint } {
  if (!data.toLowerCase().startsWith(TRANSFER_SELECTOR)) throw new Error("Payment is not a standard USDC transfer");
  const body = data.slice(TRANSFER_SELECTOR.length);
  if (body.length !== 128) throw new Error("Payment calldata has an unexpected shape");
  const to = `0x${body.slice(24, 64)}`;
  const amount = BigInt(`0x${body.slice(64, 128)}`);
  return { to, amount };
}

type Phase =
  | "loading"
  | "ready"
  | "signing"
  | "submitted"
  | "verified"
  | "failed"
  | "ambiguous";

export type BuyPhase = Phase;

/**
 * Connection/preflight errors must be visible while the user is still on the
 * ready screen (e.g. a failed "Connect wallet" click). Errors in terminal
 * phases are always shown; transient working phases surface status text
 * instead so a stale message cannot linger mid-flow.
 */
export function shouldShowError(phase: Phase, error: string | null): boolean {
  if (!error) return false;
  return phase === "ready" || phase === "failed" || phase === "ambiguous";
}

export function BuyCheckout({ handle }: { handle: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [connecting, setConnecting] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [balanceNote, setBalanceNote] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [lastHash, setLastHash] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeState | null>(null);
  const [holdUntil, setHoldUntil] = useState<string | null>(null);
  const [holdActive, setHoldActive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);

  const storageKey = `thesma:buy:${handle}`;

  function fail(message: string, toPhase: Phase = "failed") {
    setError(message);
    setPhase(toPhase);
  }

  const loadState = useCallback(async (id: string) => {
    const res = await getJson<{ intent: IntentState; outcome: OutcomeState | null }>(`/api/checkout/${id}`);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }, []);

  const reconcile = useCallback(
    async (id: string) => {
      // Idempotent server reconciliation; the browser never decides payment success.
      await postJson(`/api/checkout/${id}/verify`, {}).catch(() => null);
      const state = await loadState(id);
      if (state.outcome?.status === "VERIFIED") {
        const hold = state.outcome.holdUntil;
        setOutcome(state.outcome);
        setHoldUntil(hold);
        setHoldActive(hold !== null && new Date(hold).getTime() > Date.now());
        setPhase("verified");
        return true;
      }
      if (state.intent.status === "REJECTED") {
        fail(
          `Payment not verified: ${state.outcome?.rejectionCode ?? "rejected"}. No further charge will be attempted — this purchase cannot be reused.`,
        );
        return true;
      }
      if (state.intent.status === "AMBIGUOUS") {
        setPhase("ambiguous");
        setError(
          "Payment status is unclear onchain. It has been recorded — do NOT pay again. Wait and reload this page to let the app reconcile.",
        );
        return true;
      }
      return false;
    },
    [loadState],
  );

  const pollUntilSettled = useCallback(
    async (id: string) => {
      setPhase("submitted");
      for (let i = 0; i < 40; i++) {
        const settled = await reconcile(id).catch(() => false);
        if (settled) return;
        await new Promise((r) => setTimeout(r, 5000));
      }
      setPhase("ambiguous");
      setError("Still no confirmation from Arc. Your transaction is recorded — do NOT pay again. Reload this page to resume.");
    },
    [reconcile],
  );

  // Boot: metadata + any stored in-progress intent for this link.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await getJson<Meta>(`/api/checkout/attribution/${encodeURIComponent(handle)}`);
      if (cancelled) return;
      if (!m.ok) {
        fail(m.error);
        return;
      }
      setMeta(m.data);
      try {
        const stored = window.localStorage.getItem(storageKey);
        if (stored) {
          const { intentId: sid } = JSON.parse(stored) as { intentId: string };
          const state = await loadState(sid);
          if (cancelled) return;
          setIntentId(sid);
          if (state.intent.status === "PREPARED") {
            // Intent exists, nothing broadcast: rebuild the canonical transfer
            // from stored intent fields (same builder the backend uses) and
            // let the customer continue signing. No duplicate is created.
            setPhase("ready");
            setBusyNote("A prepared payment was found for this link — connect the same wallet to continue. No duplicate will be created.");
          } else if (state.intent.status === "SUBMITTED") {
            setLastHash(state.intent.txHash);
            await pollUntilSettled(sid);
          } else if (state.intent.status === "CONFIRMED" && state.outcome?.status === "VERIFIED") {
            const hold = state.outcome.holdUntil;
            setOutcome(state.outcome);
            setHoldUntil(hold);
            setHoldActive(hold !== null && new Date(hold).getTime() > Date.now());
            setPhase("verified");
          } else {
            setPhase("ready");
          }
          return;
        }
      } catch {
        // Corrupt local state: start clean rather than guessing.
      }
      setPhase("ready");
    })().catch((e: unknown) => {
      if (!cancelled) fail(e instanceof Error ? e.message : "Could not load this purchase page.");
    });
    return () => {
      cancelled = true;
    };
  }, [handle, storageKey, loadState, pollUntilSettled]);

  function remember(intent: string, payer: string, pay: Payment | null) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ intentId: intent, payer, payment: pay }));
    } catch {
      // Private mode etc: resume across reloads just won't be available.
    }
  }

  async function connect(): Promise<{ provider: ReturnType<typeof eth>; connected: string }> {
    const provider = eth();
    if (!meta) throw new Error("Purchase details are still loading.");
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const connected = accounts?.[0];
    if (!connected) throw new Error("No account returned by the wallet.");
    const chain = (await provider.request({ method: "eth_chainId" })) as string;
    if (chain.toLowerCase() !== `0x${meta.chainId.toString(16)}`.toLowerCase()) {
      throw new Error(`Wrong network (${chain}). Switch to Arc Mainnet (${meta.chainId}) and try again.`);
    }
    if (meta.partnerPayoutWallet && connected.toLowerCase() === meta.partnerPayoutWallet.toLowerCase()) {
      throw new Error("This wallet is the campaign's payout destination, so it cannot be the payer.");
    }
    if (connected.toLowerCase() === meta.merchant.toLowerCase()) {
      throw new Error("The merchant wallet cannot pay itself.");
    }
    return { provider, connected };
  }

  async function checkBalance(provider: ReturnType<typeof eth>, connected: string): Promise<void> {
    if (!meta) return;
    const callData = `${BALANCE_SELECTOR}${padded(connected)}`;
    const raw = (await provider
      .request({ method: "eth_call", params: [{ to: meta.usdcAddress, data: callData }, "latest"] })
      .catch(() => null)) as string | null;
    if (!raw) {
      setBalanceNote("Could not read your USDC balance — make sure the wallet holds enough for the purchase plus gas.");
      return;
    }
    const balance = BigInt(raw);
    const required = BigInt(meta.requiredAmountMicroUsdc);
    let gasBuffer = 5_000n;
    try {
      const gasPrice = BigInt(
        (await provider.request({ method: "eth_gasPrice" }).catch(() => "0x0")) as string,
      );
      const est = BigInt(
        (await provider
          .request({
            method: "eth_estimateGas",
            params: [{ from: connected, to: meta.usdcAddress, data: `${TRANSFER_SELECTOR}${padded(meta.merchant)}${required.toString(16).padStart(64, "0")}` }],
          })
          .catch(() => "0x0")) as string,
      );
      // USDC-denominated gas: wei / 1e12 = micro-USDC, doubled for headroom.
      gasBuffer = ((est * gasPrice) / 1_000_000_000_000n) * 2n + 1_000n;
    } catch {
      // Keep the conservative default buffer.
    }
    if (balance < required + gasBuffer) {
      throw new Error(
        `Insufficient USDC. You need ${fmtMicro(meta.requiredAmountMicroUsdc)} USDC plus a little extra for network fees.`,
      );
    }
    setBalanceNote(null);
  }

  async function prepare() {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const { provider, connected } = await connect();
      await checkBalance(provider, connected);
      setAccount(connected);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not connect the wallet.", "ready");
    } finally {
      setConnecting(false);
    }
  }

  async function pay() {
    if (!meta || !account) return;
    setError(null);
    setPhase("signing");
    try {
      // One intent per prepared payment; the handle is single-use server-side.
      const created = await postJson<{ intent: IntentState; payment: Payment }>(`/api/checkout/intents`, {
        attributionHandle: handle,
        payerAddress: account,
        amountMicroUsdc: meta.requiredAmountMicroUsdc,
      });
      if (!created.ok) throw new Error(created.error);
      const pay = created.data.payment;
      // Validate the backend's unsigned transfer before it ever reaches the wallet.
      if (pay.chainId !== meta.chainId) throw new Error("Payment targets an unexpected network. Stopped.");
      if (pay.expectedPayer.toLowerCase() !== account.toLowerCase()) throw new Error("Payment expects a different payer. Stopped.");
      if (pay.to.toLowerCase() !== meta.usdcAddress.toLowerCase()) throw new Error("Payment token is not the expected USDC. Stopped.");
      const decoded = decodeTransfer(pay.data);
      if (decoded.to.toLowerCase() !== meta.merchant.toLowerCase()) throw new Error("Payment recipient is not the merchant. Stopped.");
      if (decoded.amount.toString() !== meta.requiredAmountMicroUsdc) throw new Error("Payment amount differs from the required amount. Stopped.");
      setPayment(pay);
      setIntentId(created.data.intent.id);
      remember(created.data.intent.id, account, pay);
      const provider = eth();
      let hash: string;
      try {
        hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: pay.to, value: "0x0", data: pay.data }],
        })) as string;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/rejected|denied|user/i.test(msg)) {
          setPhase("ready");
          setError("You rejected the payment in your wallet. Nothing was broadcast — you can try again.");
          return;
        }
        throw new Error(`Wallet refused to send the payment: ${msg}. Nothing was recorded — safe to retry.`);
      }
      setLastHash(hash);
      // Record first; verification is a separate server step afterwards.
      const submitted = await postJson(`/api/checkout/${created.data.intent.id}`, { txHash: hash });
      if (!submitted.ok) {
        setPhase("ambiguous");
        setError(`Payment ${hash} was broadcast but could not be recorded (${submitted.error}). Do NOT pay again — reload to resume.`);
        return;
      }
      await pollUntilSettled(created.data.intent.id);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Payment failed before broadcast. Nothing was charged.");
    }
  }

  async function continuePrepared() {
    // Resume a PREPARED intent after reload: re-validate, then sign.
    if (!meta || !account || !intentId) {
      fail("Reconnect the same wallet to continue this payment.", "ready");
      return;
    }
    setError(null);
    try {
      const state = await loadState(intentId);
      if (state.intent.status !== "PREPARED") {
        await pollUntilSettled(intentId);
        return;
      }
      if (state.intent.payer.toLowerCase() !== account.toLowerCase()) {
        throw new Error("This prepared payment belongs to a different wallet. Connect that wallet to continue.");
      }
      const rebuilt: Payment = {
        chainId: meta.chainId,
        token: meta.usdcAddress,
        to: meta.usdcAddress,
        data: `${TRANSFER_SELECTOR}${padded(state.intent.merchant)}${BigInt(state.intent.amountMicroUsdc).toString(16).padStart(64, "0")}`,
        value: "0",
        expectedPayer: state.intent.payer,
        merchant: state.intent.merchant,
        amountMicroUsdc: state.intent.amountMicroUsdc,
        checkoutIntentId: state.intent.id,
        orderId: state.intent.orderId,
        expiry: "",
      };
      if (
        rebuilt.merchant.toLowerCase() !== meta.merchant.toLowerCase() ||
        rebuilt.amountMicroUsdc !== meta.requiredAmountMicroUsdc
      ) {
        throw new Error("Stored payment no longer matches this purchase. Stopped.");
      }
      setPayment(rebuilt);
      const provider = eth();
      let hash: string;
      try {
        hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: account, to: rebuilt.to, value: "0x0", data: rebuilt.data }],
        })) as string;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/rejected|denied|user/i.test(msg)) {
          setPhase("ready");
          setError("You rejected the payment in your wallet. Nothing was broadcast — you can try again.");
          return;
        }
        throw new Error(`Wallet refused to send the payment: ${msg}.`);
      }
      setLastHash(hash);
      const submitted = await postJson(`/api/checkout/${intentId}`, { txHash: hash });
      if (!submitted.ok) {
        setPhase("ambiguous");
        setError(`Payment ${hash} was broadcast but could not be recorded (${submitted.error}). Do NOT pay again — reload to resume.`);
        return;
      }
      await pollUntilSettled(intentId);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not resume this payment.");
    }
  }

  const chainName = meta ? (meta.chainId === 5042 ? "Arc Mainnet" : `Chain ${meta.chainId}`) : "Arc Mainnet";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {phase === "loading" && <p style={{ fontSize: 14, opacity: 0.8 }}>Loading purchase details…</p>}

      {meta && (phase === "ready" || phase === "failed") && (
        <>
          <dl style={{ display: "grid", gap: 6, fontSize: 14, margin: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <dt style={{ opacity: 0.7 }}>Amount</dt>
              <dd style={{ margin: 0, fontWeight: 700 }}>{fmtMicro(meta.requiredAmountMicroUsdc)} USDC</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <dt style={{ opacity: 0.7 }}>Network</dt>
              <dd style={{ margin: 0 }}>{chainName}</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <dt style={{ opacity: 0.7 }}>Token</dt>
              <dd style={{ margin: 0 }}>USDC</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <dt style={{ opacity: 0.7 }}>Merchant</dt>
              <dd style={{ margin: 0 }}><span className="mono">{short(meta.merchant)}</span></dd>
            </div>
            {account && (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <dt style={{ opacity: 0.7 }}>Your wallet</dt>
                <dd style={{ margin: 0 }}><span className="mono">{short(account)}</span></dd>
              </div>
            )}
          </dl>
          {busyNote && <p style={{ fontSize: 13, opacity: 0.85 }}>{busyNote}</p>}
          {balanceNote && <p style={{ fontSize: 13, opacity: 0.85 }}>{balanceNote}</p>}
          {!account ? (
            <button type="button" className="btn btn-primary" onClick={prepare} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          ) : intentId ? (
            <button type="button" className="btn btn-primary" onClick={continuePrepared}>
              Continue — pay {meta ? fmtMicro(meta.requiredAmountMicroUsdc) : ""} USDC
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={pay}>
              Pay with USDC
            </button>
          )}
        </>
      )}

      {phase === "signing" && (
        <p style={{ fontSize: 14 }}>Waiting for wallet — confirm the {payment ? fmtMicro(payment.amountMicroUsdc) : ""} USDC payment in MetaMask.</p>
      )}

      {phase === "submitted" && (
        <>
          <p style={{ fontSize: 14, fontWeight: 700 }}>Payment submitted</p>
          {lastHash && <p style={{ fontSize: 13 }}>Transaction: <span className="mono">{lastHash}</span></p>}
          <p style={{ fontSize: 14, opacity: 0.8 }}>Verifying on Arc — the app reads the chain independently. This can take a minute.</p>
        </>
      )}

      {phase === "verified" && outcome && (
        <div role="status" style={{ display: "grid", gap: 8 }}>
          <p style={{ fontWeight: 700 }}>Verified</p>
          <p style={{ fontSize: 14 }}>Your {meta ? fmtMicro(meta.requiredAmountMicroUsdc) : ""} USDC purchase is confirmed on Arc.</p>
          {holdActive && holdUntil ? (
            <p style={{ fontSize: 14 }}>Safety hold active until {new Date(holdUntil).toLocaleString()}.</p>
          ) : (
            <p style={{ fontSize: 14 }}>Safety hold ended.</p>
          )}
          {orderId(intentId)}
        </div>
      )}

      {shouldShowError(phase, error) && error && (
        <p className="form-error" role="alert" style={{ fontSize: 14 }}>{error}</p>
      )}
      {phase === "failed" && !intentId && (
        <button type="button" className="btn btn-ghost" onClick={() => { setError(null); setPhase("ready"); }}>
          Back
        </button>
      )}
    </div>
  );

  function orderId(id: string | null) {
    if (!id) return null;
    return <p style={{ fontSize: 13, opacity: 0.75 }}>Order reference: <span className="mono">{short(id)}</span></p>;
  }
}
