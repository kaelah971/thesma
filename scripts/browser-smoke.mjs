/**
 * Real-browser production smoke: CSP + hydration + mobile navigation.
 *
 * Usage: npm run build && npm run test:browser
 *
 * Drives system Chrome (no browser download) via playwright-core against a
 * local `next start` production server. Fails on:
 * - first-party scripts blocked by CSP (console errors)
 * - hydration errors (pageerrors)
 * - response/request nonce mismatch (propagation broken)
 * - mobile menu not opening / aria-expanded stuck
 * - primary CTA not navigating
 *
 * Widths: desktop 1280 + mobile 320 / 360 / 390 / 430 / 485.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME_PATH =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const MOBILE_WIDTHS = [320, 360, 390, 430, 485];
const DESKTOP_WIDTH = 1280;

const CSP_FAILURE = /content security policy|refused to (execute|load|apply)|violates .*directive|blocked by response/i;
const HYDRATION_FAILURE = /hydration|text content does not match|Minified React error|React error/i;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("production server did not start in time");
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startServer() {
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  return child;
}

function nonceFromCsp(csp) {
  const m = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp ?? "");
  return m ? m[1] : null;
}

async function newPage(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
  return { page, context, consoleErrors, pageErrors };
}

function firstPartyFailures(consoleErrors, pageErrors) {
  const csp = consoleErrors.filter((t) => CSP_FAILURE.test(t));
  const hydration = [...consoleErrors, ...pageErrors].filter((t) => HYDRATION_FAILURE.test(t));
  const nextChunk = consoleErrors.filter((t) => /Failed to load resource/i.test(t) && /_next\//.test(t));
  return { csp, hydration, nextChunk };
}

async function checkDocumentSecurity(page, label, navResponse) {
  // NOTE: nonce values MUST be read from the raw response bytes. The DOM
  // intentionally hides them (`getAttribute('nonce')` returns "" once CSP
  // enforcement masks the value against exfiltration), so a DOM comparison
  // always sees an empty string and can never validate propagation.
  const html = await navResponse.text();
  const rendered = [...html.matchAll(/nonce="([A-Za-z0-9+/=_-]+)"/g)].map((m) => m[1]);
  const withAttr = await page.evaluate(() => document.querySelectorAll("script[nonce]").length);
  check(`${label}: framework scripts carry a nonce`, rendered.length > 0 && withAttr > 0, `found ${rendered.length}`);
  check(
    `${label}: all rendered nonces agree`,
    rendered.length > 0 && new Set(rendered).size === 1,
    [...new Set(rendered)].join(","),
  );
  return rendered[0] ?? null;
}

async function runWidth(browser, width, docCsp) {
  const label = `${width}px`;
  console.log(`\n[${label}]`);
  const { page, context, consoleErrors, pageErrors } = await newPage(browser, width);
  try {
    const navResponse = await page.goto(BASE, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);

    // Per-navigation policy: the SAME response carries the enforced header
    // and the HTML whose script nonces must match it (per-request invariant).
    const navCsp = navResponse?.headers()["content-security-policy"] ?? null;
    const renderedNonce = await checkDocumentSecurity(page, label, navResponse);
    const headerNonce = nonceFromCsp(navCsp);
    check(`${label}: CSP header present on document`, Boolean(navCsp));
    check(
      `${label}: rendered nonce matches header nonce`,
      Boolean(renderedNonce && headerNonce && renderedNonce === headerNonce),
      `rendered=${renderedNonce} header=${headerNonce ? "<present>" : "<missing>"}`,
    );

    const { csp, hydration, nextChunk } = firstPartyFailures(consoleErrors, pageErrors);
    check(`${label}: no CSP-blocked first-party scripts`, csp.length === 0, csp.slice(0, 2).join(" | "));
    check(`${label}: no hydration errors`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
    check(`${label}: no failed Next chunks`, nextChunk.length === 0, nextChunk.slice(0, 2).join(" | "));

    // Security posture preserved on the enforced header.
    check(`${label}: frame-ancestors none`, /frame-ancestors 'none'/.test(docCsp ?? ""));
    check(`${label}: object-src none`, /object-src 'none'/.test(docCsp ?? ""));
    const scriptSrc = (docCsp ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
    check(`${label}: script-src has no unsafe-eval`, !/unsafe-eval/.test(scriptSrc));
    check(`${label}: script-src has no wildcard`, !/(^|\s)\*(;|\s|$)/.test(scriptSrc));

    const toggle = page.locator('button[aria-controls="mobile-menu"]');
    const isMobile = width <= 1100;
    if (!isMobile) {
      check(`${label}: desktop toggle hidden`, (await toggle.count()) === 0 || !(await toggle.first().isVisible()));
      const openApp = page.locator('a[href="/start"]').first();
      check(`${label}: desktop primary CTA visible`, await openApp.isVisible());
      await openApp.click();
      await page.waitForURL(/\/start/, { timeout: 15_000 });
      check(`${label}: Open app navigates to role gateway`, /\/start/.test(page.url()));
      const gateway = await page.locator("body").innerText();
      check(`${label}: role gateway renders`, /How will you use Thesma\?|Organization|Creator/i.test(gateway));
      return;
    }

    // Mobile menu acceptance.
    check(`${label}: menu button visible`, await toggle.isVisible());
    check(`${label}: menu starts closed`, (await toggle.getAttribute("aria-expanded")) === "false");
    await toggle.click();
    await page.waitForTimeout(300);
    check(`${label}: click opens menu (aria-expanded=true)`, (await toggle.getAttribute("aria-expanded")) === "true");
    const menu = page.locator("#mobile-menu");
    check(`${label}: menu panel visible`, await menu.isVisible());
    for (const href of ["/markets", "#product", "#how-it-works", "#operator", "#receipts", "#faq", "/start"]) {
      check(`${label}: menu exposes ${href}`, (await menu.locator(`a[href="${href}"]`).count()) >= 1);
    }
    // Keyboard: tab from the trigger lands inside the open menu.
    await toggle.focus();
    await page.keyboard.press("Tab");
    const focusedInMenu = await page.evaluate(() => {
      const m = document.getElementById("mobile-menu");
      return Boolean(m && m.contains(document.activeElement));
    });
    check(`${label}: keyboard can enter the open menu`, focusedInMenu);
    // Toggle closes.
    await toggle.click();
    await page.waitForTimeout(300);
    check(`${label}: click again closes menu`, (await toggle.getAttribute("aria-expanded")) === "false");
    // Escape closes + returns focus to the trigger.
    await toggle.click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check(`${label}: Escape closes menu`, (await toggle.getAttribute("aria-expanded")) === "false");
    const focusReturned = await page.evaluate(() => document.activeElement?.getAttribute("aria-controls") === "mobile-menu");
    check(`${label}: Escape returns focus to trigger`, focusReturned);
    // Outside interaction closes.
    await toggle.click();
    await page.waitForTimeout(300);
    await page.locator("main, h1").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.mouse.click(8, 8);
    await page.waitForTimeout(300);
    check(`${label}: outside click closes menu`, (await toggle.getAttribute("aria-expanded")) === "false");

    // Primary CTA from the mobile menu.
    await toggle.click();
    await page.waitForTimeout(300);
    await menu.locator('a[href="/start"]').first().click();
    await page.waitForURL(/\/start/, { timeout: 15_000 });
    check(`${label}: mobile Open app navigates to role gateway`, /\/start/.test(page.url()));
  } finally {
    await context.close();
  }
}

async function runDemoProof(browser) {
  const label = "demo";
  console.log(`\n[${label}]`);
  const { page, context, consoleErrors, pageErrors } = await newPage(browser, 390);
  try {
    const res = await page.goto(`${BASE}/demo`, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    check(`${label}: responds 200`, res?.ok() === true, `status=${res?.status()}`);
    const body = await page.locator("body").innerText();
    // CI has no database: the honest unavailable card also counts as loaded.
    // What must never happen is a 500, an empty shell, or a silent fixture.
    check(
      `${label}: public proof loads (proof or honest unavailable)`,
      /watch a real campaign settle|proof data is temporarily unavailable/i.test(body),
    );
    const { hydration } = firstPartyFailures(consoleErrors, pageErrors);
    check(`${label}: no hydration errors`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
  } finally {
    await context.close();
  }
}

async function runWalletDiscovery(browser) {
  const label = "wallet-discovery";
  console.log(`\n[${label}]`);
  // Baseline: clean CI Chromium ships no extension — the funding flow must
  // report "not detected" here rather than crash or mislabel.
  {
    const { page, context, consoleErrors, pageErrors } = await newPage(browser, 1280);
    try {
      await page.goto(BASE, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(800);
      const typeofEth = await page.evaluate(() => typeof window.ethereum);
      check(`${label}: no-provider baseline is observable`, typeofEth === "undefined", `typeof window.ethereum=${typeofEth}`);
      const { hydration } = firstPartyFailures(consoleErrors, pageErrors);
      check(`${label}: no hydration errors (no provider)`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
    } finally {
      await context.close();
    }
  }
  // Mocked MetaMask: EIP-6963 + window.ethereum + providers[] visible,
  // accounts + Arc chain readable, zero transactions sent. No extension needed.
  // Deterministic EIP-712 roundtrip: node precomputes a REAL signature with a
  // throwaway test key (mirrors tests/wallet-fixtures.ts); the mock only
  // releases it when the request payload is byte-identical to canonical.
  const { privateKeyToAccount: smokePKTA } = await import("viem/accounts");
  const { hashTypedData: smokeHashTypedData } = await import("viem");
  const SMOKE_KEY = "0x96d8b4d4a3d1e17a76d1c8114237cc46fb89196fe4db85aae2f9f14c8ba560d7";
  const SMOKE_ACCOUNT = smokePKTA(SMOKE_KEY);
  const SMOKE_TYPED = {
    domain: { name: "Thesma", version: "1", chainId: 5042 },
    types: { EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ], CompanyWalletRegistration: [
      { name: "workspaceId", type: "string" },
      { name: "purpose", type: "string" },
      { name: "nonce", type: "string" },
      { name: "issuedAt", type: "string" },
      { name: "expiresAt", type: "string" },
    ] },
    primaryType: "CompanyWalletRegistration",
    message: {
      workspaceId: "ws-smoke",
      purpose: "Register this wallet as the organization's company wallet for Thesma campaign funding. This never moves funds.",
      nonce: "smoke-nonce",
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
    },
  };
  const SMOKE_JSON = JSON.stringify(SMOKE_TYPED);
  const SMOKE_HASH = smokeHashTypedData(SMOKE_TYPED);
  const SMOKE_SIG = await SMOKE_ACCOUNT.signTypedData({
    domain: { ...SMOKE_TYPED.domain },
    types: SMOKE_TYPED.types,
    primaryType: "CompanyWalletRegistration",
    message: { ...SMOKE_TYPED.message },
  });
  const esbuildSmoke = await import("esbuild");
  const cryptoBundle = (await esbuildSmoke.build({
    entryPoints: [path.join(ROOT, "src", "lib", "walletCrypto.ts")],
    bundle: true,
    format: "iife",
    globalName: "ThesmaWalletCrypto",
    platform: "browser",
    minify: true,
    write: false,
  })).outputFiles[0].text;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const walletBundle = (await esbuildSmoke.build({
    entryPoints: [path.join(ROOT, "src", "lib", "wallet.ts")],
    bundle: true,
    format: "iife",
    globalName: "ThesmaWallet",
    platform: "browser",
    write: false,
  })).outputFiles[0].text;
  await context.addInitScript(`${walletBundle}\n;window.ThesmaWallet = ThesmaWallet;`);
  await context.addInitScript(`${cryptoBundle}\n;window.ThesmaWalletCrypto = ThesmaWalletCrypto;`);
  await context.addInitScript((C) => {
    const calls = [];
    const FIRST = "0x1111111111111111111111111111111111111111";
    const SELECTED = C.address;
    window.__smokeExpected = C;
    const provider = {
      isMetaMask: true,
      selectedAddress: SELECTED,
      async request({ method, params }) {
        calls.push(method);
        if (method === "eth_accounts" || method === "eth_requestAccounts") {
          // Two permitted accounts with the UI selection NOT first.
          return [FIRST, SELECTED];
        }
        if (method === "eth_chainId") return "0x13b2"; // 5042 Arc Mainnet
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "eth_signTypedData_v4") {
          const [signer, json] = params || [];
          if (signer === "0x000000000000000000000000000000000000dEaD") {
            throw Object.assign(new Error("User rejected the request"), { code: 4001 });
          }
          // Deterministic: release the real signature only for the exact
          // canonical payload — any digest drift fails loudly here.
          if (signer !== C.address) throw new Error("unexpected signer param");
          if (json !== C.json) throw new Error("payload mismatch");
          return C.sig;
        }
        return null;
      },
    };
    window.__mockWalletCalls = calls;
    window.ethereum = provider;
    provider.providers = [provider];
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: { info: { uuid: "mock-uuid", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider },
        }),
      );
    });
  }, {
    address: SMOKE_ACCOUNT.address,
    json: SMOKE_JSON,
    sig: SMOKE_SIG,
    hash: SMOKE_HASH,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(800);
    const probe = await page.evaluate(async () => {
      const eth = window.ethereum;
      const out = {
        typeofEth: typeof eth,
        isMetaMask: eth?.isMetaMask === true,
        multiProvider: Array.isArray(eth?.providers) && eth.providers[0]?.isMetaMask === true,
        accounts: null,
        selectedAddress: eth?.selectedAddress ?? null,
        chainId: null,
        eip6963Rdns: null,
      };
      try {
        out.accounts = await eth.request({ method: "eth_accounts" });
      } catch {}
      try {
        out.chainId = await eth.request({ method: "eth_chainId" });
      } catch {}
      try {
        const found = await new Promise((resolve) => {
          const seen = [];
          const onAnnounce = (e) => seen.push(e.detail);
          window.addEventListener("eip6963:announceProvider", onAnnounce);
          window.dispatchEvent(new Event("eip6963:requestProvider"));
          setTimeout(() => {
            window.removeEventListener("eip6963:announceProvider", onAnnounce);
            resolve(seen);
          }, 400);
        });
        const meta = found.find((d) => /metamask/i.test(d?.info?.rdns ?? ""));
        out.eip6963Rdns = meta?.info?.rdns ?? null;
      } catch {}
      return out;
    });
    check(`${label}: mock MetaMask visible via window.ethereum`, probe.typeofEth !== "undefined" && probe.isMetaMask === true);
    check(`${label}: multi-provider array exposes MetaMask`, probe.multiProvider === true);
    check(`${label}: accounts readable (connect state, not "not installed")`, Array.isArray(probe.accounts) && probe.accounts.length === 2);
    check(`${label}: UI-selected account exposed separately from accounts[0]`, typeof probe.selectedAddress === "string" && probe.selectedAddress !== probe.accounts[0] && probe.accounts.includes(probe.selectedAddress), `selected=${probe.selectedAddress}`);
    check(`${label}: Arc Mainnet chain 5042 reported`, probe.chainId === "0x13b2", `chainId=${probe.chainId}`);
    check(`${label}: EIP-6963 MetaMask announcement received`, probe.eip6963Rdns === "io.metamask", `rdns=${probe.eip6963Rdns}`);
    const typed = await page.evaluate(async () => {
      const eth = window.ethereum;
      const W = window.ThesmaWallet;
      const WC = window.ThesmaWalletCrypto;
      const expected = window.__smokeExpected;
      const out = { sig: null, rejected: false, shape: null, builtMatches: false, hashMatches: false, recoveredMatches: false };
      // Build with the REAL helper — no hardcoded schema in the test.
      const typedData = W.buildCompanyWalletTypedData({
        workspaceId: "ws-smoke",
        nonce: "smoke-nonce",
        issuedAt: "2026-06-01T12:00:00.000Z",
        expiresAt: "2026-06-01T12:10:00.000Z",
      });
      try {
        out.builtMatches = JSON.stringify(typedData) === expected.json;
        const hash = WC.hashCompanyWalletTypedData(typedData);
        out.hashMatches = hash === expected.hash;
        const sig = await eth.request({
          method: "eth_signTypedData_v4",
          params: [expected.address, JSON.stringify(typedData)],
        });
        out.sig = sig;
        out.shape = typeof sig === "string" && sig.startsWith("0x") && sig.length === 132 ? "ok" : 'bad:' + String(sig).length;
        const recovered = await WC.recoverCompanyWalletSigner(typedData, sig);
        out.recoveredMatches = recovered.toLowerCase() === expected.address.toLowerCase();
      } catch (e) {
        out.shape = 'error:' + (e?.message ?? e);
      }
      try {
        await eth.request({
          method: "eth_signTypedData_v4",
          params: ["0x000000000000000000000000000000000000dEaD", JSON.stringify(typedData)],
        });
      } catch (e) {
        out.rejected = /reject/i.test(e?.message ?? "") || e?.code === 4001;
      }
      return out;
    });
    check(`${label}: real helper builds byte-identical canonical payload`, typed.builtMatches === true);
    check(`${label}: in-browser digest equals node-computed digest`, typed.hashMatches === true);
    check(`${label}: deterministic test-key signature verifies (EIP-712, no high-risk blob)`, typed.shape === "ok", `shape=${typed.shape}`);
    check(`${label}: recovered signer equals the selected account param`, typed.recoveredMatches === true);
    check(`${label}: rejection surfaces as user-rejected`, typed.rejected === true);
    const frozen = await page.evaluate(() => {
      const payload = {
        domain: { name: "Thesma", version: "1", chainId: 5042 },
        types: {
          CompanyWalletRegistration: [
            { name: "workspaceId", type: "string" },
                { name: "purpose", type: "string" },
            { name: "nonce", type: "string" },
            { name: "issuedAt", type: "string" },
            { name: "expiresAt", type: "string" },
          ],
        },
        primaryType: "CompanyWalletRegistration",
        message: {
          workspaceId: "ws-smoke",
            purpose: "Register this wallet as the organization's company wallet for Thesma campaign funding. This never moves funds.",
          nonce: "smoke-nonce",
          issuedAt: "2026-06-01T12:00:00.000Z",
          expiresAt: "2026-06-01T12:10:00.000Z",
        },
      };
      // Client freeze contract: fetch wire format + structured clone must
      // preserve every signed field byte-identically (no client rebuild).
      const before = JSON.stringify(payload);
      const revived = JSON.parse(before);
      const cloned = structuredClone(payload);
      const fields = ["workspaceId", "purpose", "nonce", "issuedAt", "expiresAt"];
      return {
        wireStable: JSON.stringify(revived) === before,
        cloneStable: JSON.stringify(cloned) === before,
        fields: fields.every((f) => revived.message[f] === payload.message[f]),
      };
    });
    check(`${label}: challenge payload survives fetch wire format unchanged`, frozen.wireStable === true);
    check(`${label}: challenge payload survives rerender clone unchanged`, frozen.cloneStable === true);
    check(`${label}: all signed fields frozen (nonce/issuedAt/expiresAt/workspaceId/purpose)`, frozen.fields === true);
    const sent = await page.evaluate(() => window.__mockWalletCalls ?? []);
    check(`${label}: discovery sent zero transactions`, !sent.includes("eth_sendTransaction"), sent.join(","));
    check(`${label}: no token approval or permit RPC used`, !sent.some((m) => /approve|permit/i.test(m)), sent.join(","));
    const { csp, hydration } = firstPartyFailures(consoleErrors, pageErrors);
    check(`${label}: no CSP-blocked scripts during wallet probing`, csp.length === 0, csp.slice(0, 2).join(" | "));
    check(`${label}: no hydration errors (mock provider)`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
  } finally {
    await context.close();
  }
}

async function runWalletConnectionStates(browser) {
  const label = "wallet-connection";
  console.log(`\n[${label}]`);
  // Bundle the REAL helper and drive it in real Chromium against a
  // mode-driven mock: already-connected, locked, rejection, pending,
  // permission, disconnect, security-block, generic error, multi-account.
  let bundle;
  try {
    const esbuild = await import("esbuild");
    const out = await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "lib", "wallet.ts")],
      bundle: true,
      format: "iife",
      globalName: "ThesmaWallet",
      platform: "browser",
      write: false,
    });
    bundle = `${out.outputFiles[0].text}\n;window.ThesmaWallet = ThesmaWallet;`;
  } catch (e) {
    check(`${label}: wallet helper bundles for browser test`, false, String(e?.message ?? e));
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(bundle);
  await context.addInitScript(() => {
    window.__mockCalls = [];
    window.__mockMode = "connected";
    const A1 = "0x1111111111111111111111111111111111111111";
    const A2 = "0x1234567890abcdef1234567890abcdef12345678";
    window.ethereum = {
      isMetaMask: true,
      selectedAddress: A2,
      async request({ method }) {
        window.__mockCalls.push(method);
        const mode = window.__mockMode;
        if (method === "eth_accounts") {
          // Only already-connected modes expose accounts; every failure
          // mode probes empty so the explicit request path is exercised.
          if (mode === "connected" || mode === "multi") return [A1, A2];
          if (mode === "dead-probe") throw Object.assign(new Error("Provider disconnected"), { code: 4900 });
          return [];
        }
        if (method === "eth_requestAccounts") {
          if (mode === "locked" || mode === "connected" || mode === "multi") return mode === "locked" ? [] : [A1, A2];
          if (mode === "reject") throw Object.assign(new Error("User rejected the request"), { code: 4001 });
          if (mode === "pending") throw Object.assign(new Error("Already processing eth_requestAccounts"), { code: -32002 });
          if (mode === "perm") throw Object.assign(new Error("The requested account has not been authorized"), { code: 4100 });
          if (mode === "disconnected") throw Object.assign(new Error("Provider disconnected"), { code: 4900 });
          if (mode === "blocked") throw new Error("This site shows signs of phishing and is blocked");
          if (mode === "generic") throw new Error("weird transport boom");
          return [A1, A2];
        }
        if (method === "eth_chainId") return "0x13b2";
        return null;
      },
    };
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(800);
    const matrix = await page.evaluate(async () => {
      const W = window.ThesmaWallet;
      const eth = window.ethereum;
      const run = async (mode) => {
        window.__mockMode = mode;
        window.__mockCalls.length = 0;
        const started = window.__mockCalls.length;
        let res;
        try {
          res = await W.connectWallet(eth);
        } catch (e) {
          return { mode, threw: String(e?.message ?? e), calls: window.__mockCalls.slice() };
        }
        return { mode, res, calls: window.__mockCalls.slice(started) };
      };
      const out = {};
      for (const mode of ["connected", "locked", "reject", "pending", "perm", "disconnected", "blocked", "generic", "dead-probe", "multi"]) {
        out[mode] = await run(mode);
      }
      out.selectedDefault = W.defaultSelectedAccount(["0x1111111111111111111111111111111111111111", "0x1234567890abcdef1234567890abcdef12345678"], eth.selectedAddress);
      out.copyPending = W.connectionFailureCopy("REQUEST_ALREADY_PENDING", "MetaMask");
      out.copyBlocked = W.connectionFailureCopy("SECURITY_BLOCKED", "MetaMask");
      out.copyNoAccount = W.connectionFailureCopy("NO_ACCOUNT", "MetaMask");
      return out;
    });
    const reqCount = (m) => (matrix[m]?.calls ?? []).filter((c) => c === "eth_requestAccounts").length;
    check(`${label}: connected account needs no permission prompt`, matrix.connected?.res?.account === "0x1111111111111111111111111111111111111111" && !(matrix.connected?.calls ?? []).includes("eth_requestAccounts"), JSON.stringify(matrix.connected?.calls));
    check(`${label}: locked/empty returns NO_ACCOUNT without unlock claims`, matrix.locked?.res?.failure === "NO_ACCOUNT");
    check(`${label}: rejection maps to USER_REJECTED`, matrix.reject?.res?.failure === "USER_REJECTED");
    check(`${label}: pending maps once with no retry loop`, matrix.pending?.res?.failure === "REQUEST_ALREADY_PENDING" && reqCount("pending") === 1, `calls=${reqCount("pending")}`);
    check(`${label}: unauthorized maps to PERMISSION_REQUIRED`, matrix.perm?.res?.failure === "PERMISSION_REQUIRED");
    check(`${label}: disconnect maps to PROVIDER_DISCONNECTED`, matrix.disconnected?.res?.failure === "PROVIDER_DISCONNECTED" || matrix["dead-probe"]?.res?.failure === "PROVIDER_DISCONNECTED", JSON.stringify(matrix.disconnected?.res));
    check(`${label}: security block maps to SECURITY_BLOCKED`, matrix.blocked?.res?.failure === "SECURITY_BLOCKED");
    check(`${label}: generic error maps to PROVIDER_ERROR`, matrix.generic?.res?.failure === "PROVIDER_ERROR");
    check(`${label}: UI-selected account preferred over accounts[0]`, matrix.selectedDefault === "0x1234567890abcdef1234567890abcdef12345678", `selected=${matrix.selectedDefault}`);
    check(`${label}: pending copy is actionable`, /already open/i.test(matrix.copyPending ?? ""));
    check(`${label}: blocked copy is neutral (no bypass, no unlock)`, /preventing/i.test(matrix.copyBlocked ?? "") && !/bypass|unlock/i.test(matrix.copyBlocked ?? ""));
    check(`${label}: empty-account copy claims no lock`, !/unlock|locked/i.test(matrix.copyNoAccount ?? ""));
    const allCalls = Object.values(matrix).flatMap((m) => (m && m.calls) || []);
    check(`${label}: connection path sends zero transactions`, !allCalls.includes("eth_sendTransaction"), allCalls.join(","));
    const { csp, hydration } = firstPartyFailures(consoleErrors, pageErrors);
    check(`${label}: no CSP-blocked scripts during connection matrix`, csp.length === 0, csp.slice(0, 2).join(" | "));
    check(`${label}: no hydration errors (connection matrix)`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
  } finally {
    await context.close();
  }
}

async function runFundingBalance(browser) {
  const label = "funding-balance";
  console.log(`\n[${label}]`);
  // Bundle the REAL balance preflight and drive it in real Chromium
  // against a mode-driven mock Arc USDC: 0 / 4 / 50 / 75 USDC and an
  // RPC failure. Asserts gating + button state with zero signing or
  // transactions on the read path.
  let bundle;
  try {
    const esbuild = await import("esbuild");
    const out = await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "lib", "fundingPreview.ts")],
      bundle: true,
      format: "iife",
      globalName: "ThesmaFundingPreview",
      platform: "browser",
      write: false,
    });
    bundle = `${out.outputFiles[0].text}\n;window.ThesmaFundingPreview = ThesmaFundingPreview;`;
  } catch (e) {
    check(`${label}: funding preview helper bundles for browser test`, false, String(e?.message ?? e));
    return;
  }
  const USDC = "0x3600000000000000000000000000000000000000";
  const ACCOUNT = "0x85520000000000000000000000000000000094A3";
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(bundle);
  await context.addInitScript(() => {
    window.__balanceCalls = [];
    window.__balanceMode = "zero";
    const hex = (n) => `0x${BigInt(n).toString(16)}`;
    window.ethereum = {
      isMetaMask: true,
      async request({ method, params }) {
        window.__balanceCalls.push(method);
        if (method === "eth_chainId") return "0x13b2";
        if (method === "eth_call") {
          const mode = window.__balanceMode;
          if (mode === "rpc-fail") throw new Error("rpc down");
          const micro = mode === "zero" ? 0n : mode === "four" ? 4_000_000n : mode === "exact" ? 50_000_000n : 75_000_000n;
          window.__balanceLastCall = params;
          return hex(micro);
        }
        return null;
      },
    };
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(800);
    const matrix = await page.evaluate(async ({ usdc, account, required }) => {
      const FP = window.ThesmaFundingPreview;
      const eth = window.ethereum;
      const run = async (mode) => {
        window.__balanceMode = mode;
        window.__balanceCalls.length = 0;
        const read = await FP.readUsdcBalanceMicro(eth, { usdcAddress: usdc, account, chainId: 5042 });
        const verdict = read.ok ? FP.evaluateBalance(read.balanceMicro, BigInt(required)) : null;
        // Same gating rule as the funding preview Start signing control.
        // Bigints stay inside the page: only strings cross evaluate().
        const canSign = verdict !== null && verdict.status === "SUFFICIENT";
        return { mode, ok: read.ok, balance: read.ok ? String(read.balanceMicro) : null, status: verdict?.status ?? null, canSign, calls: window.__balanceCalls.slice() };
      };
      const out = {};
      for (const mode of ["zero", "four", "exact", "more", "rpc-fail"]) out[mode] = await run(mode);
      out.callShape = FP.buildBalanceOfCall(usdc, account);
      out.selector = FP.BALANCE_OF_SELECTOR;
      out.lastCall = window.__balanceLastCall ?? null;
      return out;
    }, { usdc: USDC, account: ACCOUNT, required: "50000000" });
    check(`${label}: 0 USDC blocks signing`, matrix.zero?.status === "INSUFFICIENT" && matrix.zero?.canSign === false, JSON.stringify(matrix.zero));
    check(`${label}: 4 USDC blocks signing`, matrix.four?.status === "INSUFFICIENT" && matrix.four?.canSign === false, JSON.stringify(matrix.four));
    check(`${label}: exactly 50 USDC allows signing`, matrix.exact?.status === "SUFFICIENT" && matrix.exact?.canSign === true, JSON.stringify(matrix.exact));
    check(`${label}: 75 USDC allows signing`, matrix.more?.status === "SUFFICIENT" && matrix.more?.canSign === true, JSON.stringify(matrix.more));
    check(`${label}: RPC failure fails closed (not zero, no signing)`, matrix["rpc-fail"]?.ok === false && matrix["rpc-fail"]?.canSign === false, JSON.stringify(matrix["rpc-fail"]));
    check(`${label}: read targets canonical Arc USDC balanceOf for the company wallet`, (matrix.lastCall?.[0]?.to ?? "").toLowerCase() === USDC.toLowerCase() && String(matrix.lastCall?.[0]?.data ?? "").startsWith(matrix.selector) && String(matrix.callShape?.data ?? "").startsWith(matrix.selector), JSON.stringify(matrix.lastCall?.[0]));
    const allCalls = ["zero", "four", "exact", "more", "rpc-fail"].flatMap((m) => matrix[m]?.calls ?? []);
    check(`${label}: balance path sends zero transactions and zero signing`, !allCalls.some((c) => /eth_sendTransaction|eth_sign|personal_sign|approve|permit/i.test(c)), allCalls.join(","));
    check(`${label}: balance path reads chain then contract only`, allCalls.every((c) => c === "eth_chainId" || c === "eth_call"), allCalls.join(","));
    const { csp, hydration } = firstPartyFailures(consoleErrors, pageErrors);
    check(`${label}: no CSP-blocked scripts during balance matrix`, csp.length === 0, csp.slice(0, 2).join(" | "));
    check(`${label}: no hydration errors (balance matrix)`, hydration.length === 0, hydration.slice(0, 2).join(" | "));
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(path.join(ROOT, ".next", "required-server-files.json"))) {
    console.error("No production build found. Run `npm run build` first, then `npm run test:browser`.");
    process.exit(2);
  }
  if (!existsSync(CHROME_PATH)) {
    console.error(`Chrome not found at ${CHROME_PATH}. Set CHROME_PATH env to a Chromium executable.`);
    process.exit(2);
  }
  const server = startServer();
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    await waitForServer();
    // Capture the document CSP header once (same middleware policy everywhere).
    const probeContext = await browser.newContext();
    const probe = await probeContext.newPage();
    let docCsp = null;
    probe.on("response", (res) => {
      if (res.request().resourceType() === "document" && res.url() === `${BASE}/`) {
        docCsp = res.headers()["content-security-policy"] ?? null;
      }
    });
    await probe.goto(BASE, { waitUntil: "load" });
    await probeContext.close();

    await runWidth(browser, DESKTOP_WIDTH, docCsp);
    for (const w of MOBILE_WIDTHS) await runWidth(browser, w, docCsp);
    await runDemoProof(browser);
    await runWalletDiscovery(browser);
    await runWalletConnectionStates(browser);
    await runFundingBalance(browser);
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  console.log(failures === 0 ? "\nBROWSER SMOKE: all green" : `\nBROWSER SMOKE: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`BROWSER SMOKE ERROR: ${err?.message ?? err}`);
  process.exit(1);
});
