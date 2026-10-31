"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { postJson } from "@/lib/api";
import {
  connectWallet,
  discoverWallet,
  isAccountChanged,
  selectChallengePayload,
  signCompanyWalletTypedData,
  truncateAddress,
  type CompanyWalletTypedData,
  type DiscoveredWallet,
} from "@/lib/wallet";

type Phase = "idle" | "working" | "connected" | "done" | "error";

/**
 * Owner-only company-wallet registration with EIP-712 ownership proof.
 *
 * Connect → review a structured confirmation panel → sign typed
 * registration data (eth_signTypedData_v4) → register. Connecting alone
 * registers nothing; replacing an existing wallet needs an explicit second
 * confirmation. No private keys, no seed material, no transactions — the
 * signature proves control and authorizes nothing else.
 */
export function CompanyWalletRegistration({
  workspaceId,
  workspaceName,
  currentWallet,
}: {
  workspaceId: string;
  workspaceName: string;
  currentWallet: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<DiscoveredWallet | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [confirmChange, setConfirmChange] = useState(false);

  function fail(message: string) {
    setError(message);
    setPhase("error");
  }

  async function connect() {
    setError(null);
    setNote(null);
    setPhase("working");
    try {
      setNote("Looking for an injected wallet…");
      const found = await discoverWallet();
      if (!found) {
        throw new Error("MetaMask or another compatible wallet was not detected. Install it, unlock it, then try again.");
      }
      setWallet(found);
      setNote(`Waiting for ${found.name} — approve the connection request.`);
      const res = await connectWallet(found.provider);
      if ("failure" in res) {
        if (res.failure === "USER_REJECTED") throw new Error("Connection request was rejected. Try again when ready.");
        throw new Error(`${found.name} could not connect. Unlock it and try again.`);
      }
      setAccount(res.account);
      setPhase("connected");
      setNote(null);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not connect a wallet.");
    }
  }

  // Double-submit guard: one challenge per explicit Sign click. React
  // re-renders (incl. StrictMode) must never mint a second challenge.
  const signingRef = useRef(false);

  async function register() {
    if (signingRef.current) return;
    if (!wallet || !account) return fail("Connect a wallet first.");
    signingRef.current = true;
    setError(null);
    setPhase("working");
    try {
      // Provider/account consistency: the signer must be the selected wallet.
      setNote("Confirming the selected wallet is still active…");
      const current = (await wallet.provider
        .request({ method: "eth_accounts" })
        .catch(() => null)) as string[] | null;
      const active = Array.isArray(current) ? current[0] ?? null : null;
      if (isAccountChanged(active, account)) {
        setAccount(null);
        setWallet(null);
        throw new Error("Your active wallet changed. Re-select the company wallet.");
      }
      setNote("Requesting a single-use registration challenge…");
      const ch = await postJson<{
        challenge: { typedData: CompanyWalletTypedData; nonce: string; issuedAt: string; expiresAt: string };
      }>(`/api/workspaces/${workspaceId}/company-wallet/challenge`, { address: account });
      if (!ch.ok || !ch.data?.challenge) {
        throw new Error((ch as { error?: string }).error ?? "Could not start registration. Try again.");
      }
      // Frozen challenge: the server payload is the single source of truth.
      // It is signed VERBATIM — fields are never rebuilt client-side (a raw
      // account can differ in checksum case from the normalized challenge
      // wallet, which falsely tripped rebuild-and-compare checks).
      const frozen = selectChallengePayload({
        challenge: ch.data.challenge,
        workspaceId,
        selectedAccount: account,
        activeAccount: active,
      });
      if ("error" in frozen) {
        if (frozen.error === "ACCOUNT_CHANGED") {
          setAccount(null);
          setWallet(null);
          throw new Error("Your active wallet changed. Re-select the company wallet.");
        }
        throw new Error("Registration request does not match this workspace. Start over.");
      }
      const { typedData } = frozen;
      const nonce = ch.data.challenge.nonce;
      setNote(`Waiting for ${wallet.name} — review and sign the registration request. It never moves funds.`);
      const signed = await signCompanyWalletTypedData(wallet.provider, account, typedData);
      if ("failure" in signed) {
        if (signed.failure === "USER_REJECTED") throw new Error("Signature request was rejected. Nothing was registered.");
        throw new Error(`${wallet.name} could not sign. Try again.`);
      }
      const res = await postJson<{ workspace: { companyWallet: string | null } }>(
        `/api/workspaces/${workspaceId}/company-wallet`,
        { address: account, nonce, signature: signed.signature, ...(confirmChange ? { confirmChange: true } : {}) },
      );
      if (!res.ok) {
        const body = res as { error?: string; code?: string; details?: { recovered?: string } };
        if (body.code === "WALLET_CHANGE_REQUIRES_CONFIRMATION") {
          setError("A different company wallet is already registered. Tick the replacement confirmation to proceed.");
          setPhase("connected");
          return;
        }
        if (body.code === "SIGNER_MISMATCH") {
          const rec = body.details?.recovered;
          throw new Error(
            `Signature came from ${rec ? truncateAddress(rec) : "a different wallet"}. Sign with the wallet you want to register.`,
          );
        }
        if (body.code === "CHALLENGE_EXPIRED") {
          throw new Error("Registration request expired. Start again.");
        }
        if (body.code === "CHALLENGE_USED" || body.code === "CHALLENGE_NOT_FOUND") {
          throw new Error("Registration request already used or not found. Start again.");
        }
        if (body.code === "CHALLENGE_MISMATCH") {
          throw new Error("Registration request does not match this workspace or wallet. Start over.");
        }
        throw new Error(body.error ?? "Registration failed. Try again.");
      }
      setPhase("done");
      setNote(null);
      router.refresh();
    } catch (e) {
      fail(e instanceof Error ? e.message : "Registration failed. Try again.");
    } finally {
      signingRef.current = false;
    }
  }

  function restart() {
    signingRef.current = false;
    setAccount(null);
    setWallet(null);
    setConfirmChange(false);
    setError(null);
    setNote(null);
    setPhase("idle");
  }

  if (phase === "done") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <p style={{ fontSize: 14 }}>
          Company wallet registered: <span className="mono" title={account ?? ""}>{truncateAddress(account)}</span>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      <p style={{ fontSize: 13, opacity: 0.85 }}>
        {currentWallet
          ? "Replace the registered wallet. The new wallet signs to prove control; historic funding records never change."
          : "Register the wallet that will sign and fund campaigns. Connecting alone registers nothing — you review and sign first."}
      </p>
      {phase === "idle" && (
        <button type="button" className="btn btn-primary btn-sm" onClick={connect}>
          {currentWallet ? "Connect a different wallet" : "Connect company wallet"}
        </button>
      )}
      {phase === "working" && <p style={{ fontSize: 14 }}>{note ?? "Working…"}</p>}
      {phase === "connected" && account && (
        <>
          <div style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "12px 14px", display: "grid", gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Register company wallet</strong>
            <span style={{ fontSize: 13 }}>Workspace: <strong>{workspaceName}</strong></span>
            <span style={{ fontSize: 13 }}>Wallet: <span className="mono" title={account}>{truncateAddress(account)}</span>{wallet ? ` (${wallet.name})` : ""}</span>
            <span style={{ fontSize: 13 }}>Network: <strong>Arc Mainnet</strong></span>
            <span style={{ fontSize: 13 }}>This signature:</span>
            <ul style={{ fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
              <li>✓ proves you control this wallet</li>
              <li>✓ registers it for {workspaceName} funding</li>
            </ul>
            <span style={{ fontSize: 13 }}>It does NOT:</span>
            <ul style={{ fontSize: 12.5, margin: 0, paddingLeft: 18 }}>
              <li>× move USDC</li>
              <li>× approve token spending</li>
              <li>× authorize a campaign payment</li>
            </ul>
          </div>
          {currentWallet && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={confirmChange} onChange={(e) => setConfirmChange(e.target.checked)} />
              Replace the currently registered wallet ({truncateAddress(currentWallet)})
            </label>
          )}
          <div>
            <button type="button" className="btn btn-primary btn-sm" onClick={register}>
              Sign registration message
            </button>
          </div>
        </>
      )}
      {phase === "error" && error && (
        <p className="form-error" role="alert" style={{ fontSize: 13 }}>{error}</p>
      )}
      {phase === "error" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPhase(account ? "connected" : "idle"); setError(null); }}>
            Back
          </button>
          <button type="button" className="btn btn-sm" onClick={restart}>
            Restart registration
          </button>
        </div>
      )}
    </div>
  );
}
