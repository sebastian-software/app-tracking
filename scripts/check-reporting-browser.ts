import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createReportingHandler, adminTokenHash } from "../src/reporting/handler.ts";
import { fixtureKey, usageFixture } from "../test/fixtures/reporting.ts";

let requests = 0;
const handle = createReportingHandler(
  () => ({
    async usage(query) {
      requests++;
      return usageFixture(query);
    },
  }),
  [await adminTokenHash(fixtureKey)],
);
const server = createServer((incoming, outgoing) => {
  void (async () => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (typeof value === "string") headers.set(key, value);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method,
      headers,
    });
    incoming.resume();
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  })().catch(() => {
    outgoing.writeHead(500);
    outgoing.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/admin`);
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.equal(requests, 0);
  await page.getByLabel("Maintainer access key").fill(fixtureKey);
  await page.getByRole("button", { name: "Open statistics" }).click();
  await page.getByText("23,514", { exact: true }).waitFor();
  assert.equal(requests, 1);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
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
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.equal(await page.locator("#commands").innerText(), "");
  assert.equal(await page.locator("#key").inputValue(), "");
  await page.reload();
  await page.getByRole("heading", { name: "Maintainer access" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Reporting browser: access, filters, no credential storage, safe text, empty/failure/retry, logout, responsive layout, and accessibility passed (synthetic data).",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
