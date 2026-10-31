"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api";
import {
  connectWallet,
  connectionFailureCopy,
  defaultSelectedAccount,
  discoverWallet,
  resolveAccountChange,
  selectChallengePayload,
  signCompanyWalletTypedData,
  truncateAddress,
  type CompanyWalletTypedData,
  type DiscoveredWallet,
} from "@/lib/wallet";

type Phase = "idle" | "working" | "connected" | "verified" | "done" | "error";

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
  const [availableAccounts, setAvailableAccounts] = useState<string[]>([]);
  const [confirmChange, setConfirmChange] = useState(false);
  const [proof, setProof] = useState<{ nonce: string; provedWallet: string } | null>(null);
  const availableRef = useRef<string[]>([]);

  function commitAccounts(list: string[]) {
    availableRef.current = list;
    setAvailableAccounts(list);
  }

  // Live account tracking: the SAME discovered provider is the only event
  // source — window.ethereum from another extension is never consulted.
  // Any membership change invalidates the flow; a non-empty new list moves
  // the explicit selection to the wallet's freshly selected account.
  useEffect(() => {
    const provider = wallet?.provider;
    if (!provider?.on || (phase !== "connected" && phase !== "working")) return;
    const handleAccountsChanged = (...args: unknown[]) => {
      const raw = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      const next = raw.filter((a): a is string => typeof a === "string");
      const res = resolveAccountChange(availableRef.current, next);
      if (!res.changed) return;
      commitAccounts(next);
      if (res.selection === null) {
        setAccount(null);
        setWallet(null);
        setError("Your active MetaMask account changed. Restart registration.");
        setPhase("error");
      } else {
        setAccount(res.selection);
        setNote(`Active account changed — selection updated to ${truncateAddress(res.selection)}. Review before signing.`);
      }
    };
    provider.on("accountsChanged", handleAccountsChanged);
    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, [wallet, phase]);

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
      if ("failure" in res) throw new Error(connectionFailureCopy(res.failure, found.name));
      const exposed = (await found.provider.request({ method: "eth_accounts" }).catch(() => null)) as unknown;
      const list = Array.isArray(exposed) ? exposed.filter((a): a is string => typeof a === "string") : [res.account];
      if (list.length === 0) throw new Error(connectionFailureCopy("NO_ACCOUNT", found.name));
      // Explicit selection: never assume accounts[0] is the UI-selected one.
      const selected = defaultSelectedAccount(list, found.provider.selectedAddress) ?? list[0];
      commitAccounts(list);
      setAccount(selected);
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
      // The explicitly selected account — never accounts[0] by assumption.
      const selected = account;
      // Fresh availability read from the SAME provider (never window.ethereum).
      setNote("Confirming the selected wallet is still active…");
      const current = (await wallet.provider
        .request({ method: "eth_accounts" })
        .catch(() => null)) as unknown;
      const fresh = Array.isArray(current) ? current.filter((a): a is string => typeof a === "string") : [];
      if (!fresh.some((a) => a.toLowerCase() === selected.toLowerCase())) {
        setAccount(null);
        setWallet(null);
        throw new Error("Your active wallet changed. Re-select the company wallet.");
      }
      commitAccounts(fresh);
      setNote("Requesting a workspace-bound registration challenge…");
      const ch = await postJson<{
        challenge: { typedData: CompanyWalletTypedData; nonce: string; issuedAt: string; expiresAt: string };
      }>(`/api/workspaces/${workspaceId}/company-wallet/challenge`, {});
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
        selectedAccount: selected,
        availableAccounts: fresh,
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
      // The signer param is the explicitly selected account. Whatever key
      // MetaMask actually uses becomes the proved identity server-side —
      // the client never asserts which wallet will be registered.
      setNote(`Waiting for ${wallet.name} — review and sign the registration request. It never moves funds.`);
      const signed = await signCompanyWalletTypedData(wallet.provider, selected, typedData);
      if ("failure" in signed) {
        if (signed.failure === "USER_REJECTED") throw new Error("Signature request was rejected. Nothing was registered.");
        throw new Error(`${wallet.name} could not sign. Try again.`);
      }
      const proof = await postJson<{ provedWallet: string }>(
        `/api/workspaces/${workspaceId}/company-wallet/prove`,
        { nonce, signature: signed.signature },
      );
      if (!proof.ok || !proof.data?.provedWallet) {
        const body = proof as { error?: string; code?: string };
        if (body.code === "CHALLENGE_EXPIRED") {
          throw new Error("Registration request expired. Start again.");
        }
        if (body.code === "CHALLENGE_USED" || body.code === "CHALLENGE_NOT_FOUND") {
          throw new Error("Registration request already used or not found. Start again.");
        }
        if (body.code === "CHALLENGE_MISMATCH") {
          throw new Error("Registration request does not match this workspace or user. Start over.");
        }
        throw new Error(body.error ?? "Ownership proof failed. Try again.");
      }
      // Phase A complete: the SERVER recovered this wallet. Nothing is
      // registered yet — the user now explicitly confirms THAT wallet.
      setProof({ nonce, provedWallet: proof.data.provedWallet });
      setConfirmChange(false);
      setPhase("verified");
      setNote(null);
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
    setProof(null);
    setError(null);
    setNote(null);
    setPhase("idle");
  }

  function cancelProof() {
    setProof(null);
    setConfirmChange(false);
    setError(null);
    setNote(null);
    setPhase(account ? "connected" : "idle");
  }

  async function confirm() {
    if (!proof) return fail("Sign the ownership proof first.");
    setError(null);
    setPhase("working");
    setNote("Registering the verified wallet…");
    try {
      // The recovered signer travels server-side only: the client sends no
      // address, so substitution is structurally impossible.
      const res = await postJson<{ workspace: { companyWallet: string | null } }>(
        `/api/workspaces/${workspaceId}/company-wallet`,
        { nonce: proof.nonce, ...(confirmChange ? { confirmChange: true } : {}) },
      );
      if (!res.ok) {
        const body = res as { error?: string; code?: string };
        if (body.code === "WALLET_CHANGE_REQUIRES_CONFIRMATION") {
          setError("A different company wallet is already registered. Tick the replacement confirmation to proceed.");
          setPhase("verified");
          return;
        }
        if (body.code === "CHALLENGE_EXPIRED") {
          throw new Error("Registration request expired. Start again.");
        }
        if (body.code === "CHALLENGE_USED" || body.code === "CHALLENGE_NOT_FOUND") {
          throw new Error("Registration request already used or not found. Start again.");
        }
        if (body.code === "PROOF_REQUIRED") {
          throw new Error("Ownership proof is missing. Sign again to restart.");
        }
        throw new Error(body.error ?? "Registration failed. Try again.");
      }
      setAccount(proof.provedWallet);
      setProof(null);
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
            {availableAccounts.length > 1 ? (
              <span style={{ fontSize: 13, display: "grid", gap: 4 }}>
                <strong>Select the wallet to register{wallet ? ` (${wallet.name})` : ""}:</strong>
                {availableAccounts.map((a) => (
                  <label key={a} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="radio"
                      name="company-wallet-account"
                      checked={account.toLowerCase() === a.toLowerCase()}
                      onChange={() => setAccount(a)}
                    />
                    <span className="mono" title={a}>{truncateAddress(a)}</span>
                  </label>
                ))}
              </span>
            ) : (
              <span style={{ fontSize: 13 }}>Wallet: <span className="mono" title={account}>{truncateAddress(account)}</span>{wallet ? ` (${wallet.name})` : ""}</span>
            )}
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
          <div>
            <button type="button" className="btn btn-primary btn-sm" onClick={register}>
              Sign ownership proof
            </button>
          </div>
        </>
      )}
      {phase === "verified" && proof && (
        <>
          <div style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "12px 14px", display: "grid", gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Wallet ownership verified</strong>
            <span style={{ fontSize: 13 }}>MetaMask proved control of:</span>
            <span className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }} title={proof.provedWallet}>{proof.provedWallet}</span>
            <span style={{ fontSize: 13 }}>Register this wallet as {workspaceName}&apos;s company wallet?</span>
            {currentWallet && currentWallet.toLowerCase() !== proof.provedWallet.toLowerCase() && (
              <span style={{ fontSize: 12.5 }}>Current: <span className="mono" title={currentWallet}>{truncateAddress(currentWallet)}</span> · Verified new wallet: <span className="mono" title={proof.provedWallet}>{truncateAddress(proof.provedWallet)}</span></span>
            )}
          </div>
          {currentWallet && currentWallet.toLowerCase() !== proof.provedWallet.toLowerCase() && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={confirmChange} onChange={(e) => setConfirmChange(e.target.checked)} />
              Confirm wallet change — replace the currently registered wallet
            </label>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={confirm}>
              Register wallet
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelProof}>
              Cancel
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
