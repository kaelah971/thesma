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
