"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";
import {
  buildCompanyWalletMessage,
  connectWallet,
  discoverWallet,
  signCompanyWalletMessage,
  truncateAddress,
  type DiscoveredWallet,
} from "@/lib/wallet";

type Phase = "idle" | "working" | "connected" | "done" | "error";

/**
 * Owner-only company-wallet registration. Discover → connect → sign a
 * workspace-bound challenge → register. Connecting alone registers nothing;
 * replacing an existing wallet needs an explicit second confirmation.
 * No private keys, no seed phrases, no transactions — a signature only.
 */
export function CompanyWalletRegistration({
  workspaceId,
  currentWallet,
}: {
  workspaceId: string;
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

  async function register() {
    if (!wallet || !account) return fail("Connect a wallet first.");
    setError(null);
    setPhase("working");
    try {
      const message = buildCompanyWalletMessage(workspaceId, account);
      setNote(`Waiting for ${wallet.name} — sign the registration message (no funds move).`);
      const signed = await signCompanyWalletMessage(wallet.provider, account, message);
      if ("failure" in signed) {
        if (signed.failure === "USER_REJECTED") throw new Error("Signature request was rejected. Nothing was registered.");
        throw new Error(`${wallet.name} could not sign. Try again.`);
      }
      const res = await postJson<{ workspace: { companyWallet: string | null } }>(
        `/api/workspaces/${workspaceId}/company-wallet`,
        { address: account, signature: signed.signature, ...(confirmChange ? { confirmChange: true } : {}) },
      );
      if (!res.ok) {
        const code = (res as { code?: string }).code;
        if (code === "WALLET_CHANGE_REQUIRES_CONFIRMATION") {
          setError("A different company wallet is already registered. Tick the replacement confirmation to proceed.");
          setPhase("connected");
          return;
        }
        throw new Error((res as { error?: string }).error ?? "Registration failed. Try again.");
      }
      setPhase("done");
      setNote(null);
      router.refresh();
    } catch (e) {
      fail(e instanceof Error ? e.message : "Registration failed. Try again.");
    }
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
          ? "Replace the registered wallet. The new wallet must sign to prove control; historic funding records never change."
          : "Register the wallet that will sign and fund campaigns. Connecting alone registers nothing — you sign to prove control."}
      </p>
      {account && (
        <p style={{ fontSize: 14 }}>
          Selected wallet: <span className="mono" title={account}>{truncateAddress(account)}</span>
          {wallet ? ` (${wallet.name})` : ""}
        </p>
      )}
      {phase === "idle" && (
        <button type="button" className="btn btn-primary btn-sm" onClick={connect}>
          {currentWallet ? "Connect a different wallet" : "Connect company wallet"}
        </button>
      )}
      {phase === "working" && <p style={{ fontSize: 14 }}>{note ?? "Working…"}</p>}
      {phase === "connected" && account && (
        <>
          {currentWallet && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={confirmChange} onChange={(e) => setConfirmChange(e.target.checked)} />
              Replace the currently registered wallet ({truncateAddress(currentWallet)})
            </label>
          )}
          <div>
            <button type="button" className="btn btn-primary btn-sm" onClick={register}>
              Sign &amp; register
            </button>
          </div>
        </>
      )}
      {phase === "error" && error && (
        <p className="form-error" role="alert" style={{ fontSize: 13 }}>{error}</p>
      )}
      {phase === "error" && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPhase(account ? "connected" : "idle"); setError(null); }}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}
