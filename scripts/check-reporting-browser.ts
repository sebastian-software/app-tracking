import { profileFixture } from "../test/fixtures/profiles.ts";
import { historyFixture } from "../test/fixtures/history.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportingHandler } from "../src/reporting/handler.ts";
import { eventFixture } from "../test/fixtures/events.ts";
import { usageFixture } from "../test/fixtures/reporting.ts";
import { workosBrowserFixture } from "../test/fixtures/workos-browser.ts";
import type { ReportingStorage } from "../src/reporting/storage.ts";

let requests = 0;
let handle: ReturnType<typeof createReportingHandler>;
/* The handler is initialized after the ephemeral port is known. */
const storage: () => ReportingStorage = () => ({
  async profiles(query) {
    requests++;
    return profileFixture(query);
  },
  async history(query) {
    requests++;
    return historyFixture(query);
  },
  async events(query) {
    requests++;
    return eventFixture(query);
  },
  async usage(query) {
    requests++;
    return usageFixture(query);
  },
});
const server = createServer((incoming, outgoing) => {
  void (async () => {
    const fixtureURL = new URL(incoming.url!, `http://127.0.0.1:${port}`);
    if (
      fixtureURL.pathname === "/__workos-fixture/authorize" ||
      fixtureURL.pathname === "/__workos-fixture/logout"
    ) {
      const target = new URL(
        fixtureURL.searchParams.get(
          fixtureURL.pathname.endsWith("authorize") ? "redirect_uri" : "return_to",
        )!,
      );
      assert.equal(target.origin, `http://127.0.0.1:${port}`);
      if (fixtureURL.pathname.endsWith("authorize")) {
        target.searchParams.set("code", "fixture-code");
        target.searchParams.set("state", fixtureURL.searchParams.get("state")!);
      }
      outgoing.writeHead(303, { Location: target.href });
      outgoing.end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === "string") headers.set(key, value);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method,
      headers,
    });
    incoming.resume();
    const response = await handle(request);
    const responseHeaders = Object.fromEntries(response.headers),
      location = responseHeaders.location;
    function localProvider(value: string) {
      const url = new URL(value, `http://127.0.0.1:${port}`);
      if (url.origin !== "https://api.workos.com") return value;
      url.pathname = url.pathname.endsWith("authorize")
        ? "/__workos-fixture/authorize"
        : "/__workos-fixture/logout";
      return `http://127.0.0.1:${port}` + url.pathname + url.search;
    }
    if (location) responseHeaders.location = localProvider(location);
    let body = new Uint8Array(await response.arrayBuffer());
    if (fixtureURL.pathname === "/admin/logout" && response.status === 200) {
      const result = JSON.parse(new TextDecoder().decode(body));
      result.location = localProvider(result.location);
      body = new TextEncoder().encode(JSON.stringify(result));
    }
    outgoing.writeHead(response.status, {
      ...responseHeaders,
      "set-cookie": response.headers.getSetCookie(),
    });
    outgoing.end(body);
  })().catch(() => {
    outgoing.writeHead(500);
    outgoing.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const provider = await workosBrowserFixture(`http://127.0.0.1:${port}`);
handle = createReportingHandler(storage, provider.auth);
const browser = await chromium.launch({
  headless: true,
  proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" },
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/admin`);
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.equal(requests, 0);
  await page.getByText("Sign in to view usage statistics.", { exact: true }).waitFor();
  await mkdir("dist/reporting-evidence", { recursive: true });
  await page.screenshot({ path: "dist/reporting-evidence/login.png", fullPage: true });
  await page.getByRole("link", { name: "Continue with WorkOS" }).click();
  await page.getByText("23,514", { exact: true }).waitFor();
  assert.equal(requests, 1);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const cookies = await page.context().cookies();
  assert.ok(
    cookies.some(
      (cookie) =>
        cookie.name === "__Host-app-tracking-session" &&
        cookie.httpOnly &&
        cookie.secure &&
        cookie.sameSite === "Lax",
    ),
  );
  assert.ok(!(await page.content()).includes("fixture-refresh"));
  const axe = await readFile(
    new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    "utf8",
  );
  await page.evaluate(axe);
  const audit = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run(options: unknown): Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    return axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  });
  assert.deepEqual(
    audit.violations.map((item) => item.id),
    [],
  );
  await mkdir("dist/reporting-evidence", { recursive: true });
  await page.screenshot({ path: "dist/reporting-evidence/desktop.png", fullPage: true });
  await page.getByLabel("Report", { exact: true }).selectOption("events");
  await page.getByLabel("Metric", { exact: true }).selectOption("language.use");
  await page.getByText("source: dependency", { exact: false }).waitFor();
  await page.getByLabel("Tool", { exact: true }).selectOption("ferriki");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByText("source: explicit", { exact: false }).waitFor();
  assert.equal(await page.locator("#count-label").innerText(), "Language-use observations");
  await page.getByLabel("Breakdown", { exact: true }).selectOption("cpu_family");
  assert.equal(await page.locator("#systems td").first().innerText(), "unknown");
  await page.evaluate(axe);
  const eventAudit = await page.evaluate(async () => {
    return (
      window as unknown as {
        axe: { run(options: unknown): Promise<{ violations: { id: string }[] }> };
      }
    ).axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
  });
  assert.deepEqual(
    eventAudit.violations.map((item) => item.id),
    [],
  );
  await page.screenshot({ path: "dist/reporting-evidence/events-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: "dist/reporting-evidence/events-mobile.png", fullPage: true });
  await page.route("**/v1/admin/events?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "service_unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page
    .getByText("Statistics are unavailable. No zero values have been substituted.")
    .waitFor();
  assert.equal(await page.locator("#systems").innerText(), "");
  await page.unroute("**/v1/admin/events?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByText("source: explicit", { exact: false }).waitFor();
  await page.getByLabel("Report", { exact: true }).selectOption("legacy");
  await page.getByText("23,514", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Tool", { exact: true }).inputValue(), "all");
  assert.equal(await page.locator("#systems-panel").isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByLabel("Report", { exact: true }).selectOption("history");
  await page
    .getByText("Monthly summaries loaded. Gaps and withheld groups are not zeroes.")
    .waitFor();
  assert.equal(await page.locator("#detail-report").isVisible(), false);
  assert.equal(await page.locator("#from").getAttribute("type"), "month");
  assert.ok((await page.locator("#months").innerText()).includes("Incomplete"));
  assert.ok((await page.locator("#months").innerText()).includes("Withheld"));
  assert.ok(
    (await page.locator("#history-breakdowns").innerText()).includes("version_family: 2.0"),
  );
  await page.evaluate(axe);
  const historyAudit = await page.evaluate(async () =>
    (
      window as unknown as {
        axe: { run(options: unknown): Promise<{ violations: { id: string }[] }> };
      }
    ).axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }),
  );
  assert.deepEqual(
    historyAudit.violations.map((item) => item.id),
    [],
  );
  await page.screenshot({ path: "dist/reporting-evidence/history-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "dist/reporting-evidence/history-mobile.png", fullPage: true });
  await page.getByLabel("Report", { exact: true }).selectOption("profiles");
  await page
    .getByText("Overlap loaded for the complete selected period.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#tool-filter").isVisible(), false);
  assert.equal(await page.locator("#mode-filter").isVisible(), false);
  assert.ok((await page.locator("#profiles").innerText()).includes("dalo + palamedes"));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(axe);
  const profileAudit = await page.evaluate(async () =>
    (
      window as unknown as {
        axe: { run(options: unknown): Promise<{ violations: { id: string }[] }> };
      }
    ).axe.run({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }),
  );
  assert.deepEqual(
    profileAudit.violations.map((item) => item.id),
    [],
  );
  await page.screenshot({ path: "dist/reporting-evidence/profiles-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "dist/reporting-evidence/profiles-desktop.png", fullPage: true });
  await page.getByLabel("Report", { exact: true }).selectOption("legacy");
  await page.getByText("23,514", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await page
    .getByText("Loaded. Recent seven days are provisional; today may be partial.")
    .waitFor();
  assert.ok(requests >= 2);
  await page.route("**/v1/admin/usage?**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.versions[0].tool_version = '<img src=x onerror="globalThis.leaked=true">';
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#versions td")
      ?.textContent?.includes('<img src=x onerror="globalThis.leaked=true">'),
  );
  assert.equal(await page.locator("#versions img").count(), 0);
  assert.equal(
    await page.evaluate(() => (window as unknown as { leaked?: boolean }).leaked),
    undefined,
  );
  await page.unroute("**/v1/admin/usage?**");
  await page.route("**/v1/admin/usage?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "service_unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page
    .getByText("Statistics are unavailable. No zero values have been substituted.")
    .waitFor();
  assert.equal(await page.locator("#invocations").innerText(), "—");
  await page.unroute("**/v1/admin/usage?**");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByText("23,514", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      Number(document.querySelector("#chart svg")?.getAttribute("viewBox")?.split(" ")[2]) < 600,
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: "dist/reporting-evidence/mobile.png", fullPage: true });
  await page.route("**/v1/admin/usage?**", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.coverage.has_observations = false;
    for (const key of Object.keys(body.totals)) body.totals[key] = "0";
    for (const row of body.daily)
      for (const key of ["invocations", "active_installations", "active_projects"]) row[key] = "0";
    body.commands = [];
    body.versions = [];
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByText("No reports have been received for this period.").waitFor();
  assert.equal(await page.locator("#invocations").innerText(), "0");
  assert.equal(await page.locator("#unknown").innerText(), "—");
  await page.unroute("**/v1/admin/usage?**");
  await page.route("**/admin/logout", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "service_unavailable" }),
    }),
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByText("Could not sign out. Use Sign out to try again.").waitFor();
  assert.equal(await page.locator("#workspace").isVisible(), false);
  assert.equal(await page.locator("#retry").isVisible(), false);
  await page.unroute("**/admin/logout");
  await Promise.all([
    page.waitForEvent("framenavigated"),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.equal(await page.locator("#commands").innerText(), "");
  assert.equal(
    (await page.context().cookies()).filter(
      (cookie) => cookie.name === "__Host-app-tracking-session",
    ).length,
    0,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Reporting browser: WorkOS callback/PKCE, secure cookies, access, filters, no token storage, safe text, empty/failure/retry, logout/reload, responsive layout, and accessibility passed (synthetic provider/data).",
  );
} finally {
  await browser.close();
  provider.restore();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
