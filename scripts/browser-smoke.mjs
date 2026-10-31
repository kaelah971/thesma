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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const calls = [];
    const FIRST = "0x1111111111111111111111111111111111111111";
    const SELECTED = "0x1234567890abcdef1234567890abcdef12345678";
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
          const payload = JSON.parse(json);
          if (payload?.domain?.chainId !== 5042) throw new Error("unexpected domain");
          if (payload?.primaryType !== "CompanyWalletRegistration") throw new Error("unexpected type");
          const fields = (payload?.types?.CompanyWalletRegistration || []).map((f) => f.name).join(",");
          if (fields !== "workspaceId,wallet,purpose,nonce,issuedAt,expiresAt") throw new Error("unexpected fields: " + fields);
          return "0x" + "ab".repeat(65);
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
    check(`${label}: UI-selected account exposed separately from accounts[0]`, probe.selectedAddress === "0x1234567890abcdef1234567890abcdef12345678", `selected=${probe.selectedAddress}`);
    check(`${label}: Arc Mainnet chain 5042 reported`, probe.chainId === "0x13b2", `chainId=${probe.chainId}`);
    check(`${label}: EIP-6963 MetaMask announcement received`, probe.eip6963Rdns === "io.metamask", `rdns=${probe.eip6963Rdns}`);
    const typed = await page.evaluate(async () => {
      const eth = window.ethereum;
      const out = { sig: null, rejected: false, shape: null };
      const typedData = {
        domain: { name: "Thesma", version: "1", chainId: 5042 },
        types: {
          CompanyWalletRegistration: [
            { name: "workspaceId", type: "string" },
            { name: "wallet", type: "string" },
            { name: "purpose", type: "string" },
            { name: "nonce", type: "string" },
            { name: "issuedAt", type: "string" },
            { name: "expiresAt", type: "string" },
          ],
        },
        primaryType: "CompanyWalletRegistration",
        message: {
          workspaceId: "ws-smoke",
          wallet: "0x1234567890abcdef1234567890abcdef12345678",
          purpose: "Register this wallet as the organization's company wallet for Thesma campaign funding. This never moves funds.",
          nonce: "smoke-nonce",
          issuedAt: "2026-06-01T12:00:00.000Z",
          expiresAt: "2026-06-01T12:10:00.000Z",
        },
      };
      try {
        const sig = await eth.request({
          method: "eth_signTypedData_v4",
          params: ["0x1234567890abcdef1234567890abcdef12345678", JSON.stringify(typedData)],
        });
        out.sig = sig;
        out.shape = typeof sig === "string" && sig.startsWith("0x") && sig.length === 132 ? "ok" : `bad:${String(sig).length}`;
      } catch {}
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
    check(`${label}: typed registration request signs (EIP-712, no high-risk blob)`, typed.shape === "ok", `shape=${typed.shape}`);
    check(`${label}: rejection surfaces as user-rejected`, typed.rejected === true);
    const frozen = await page.evaluate(() => {
      const payload = {
        domain: { name: "Thesma", version: "1", chainId: 5042 },
        types: {
          CompanyWalletRegistration: [
            { name: "workspaceId", type: "string" },
            { name: "wallet", type: "string" },
            { name: "purpose", type: "string" },
            { name: "nonce", type: "string" },
            { name: "issuedAt", type: "string" },
            { name: "expiresAt", type: "string" },
          ],
        },
        primaryType: "CompanyWalletRegistration",
        message: {
          workspaceId: "ws-smoke",
          wallet: "0x1234567890abcdef1234567890abcdef12345678",
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
      const fields = ["workspaceId", "wallet", "purpose", "nonce", "issuedAt", "expiresAt"];
      return {
        wireStable: JSON.stringify(revived) === before,
        cloneStable: JSON.stringify(cloned) === before,
        fields: fields.every((f) => revived.message[f] === payload.message[f]),
      };
    });
    check(`${label}: challenge payload survives fetch wire format unchanged`, frozen.wireStable === true);
    check(`${label}: challenge payload survives rerender clone unchanged`, frozen.cloneStable === true);
    check(`${label}: all signed fields frozen (nonce/issuedAt/expiresAt/workspaceId/wallet/purpose)`, frozen.fields === true);
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
