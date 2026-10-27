import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Serve the exact Pages artifact under its repository prefix to catch broken assets.
const files = new Map([
  ["/app-tracking/", ["index.html", "text/html; charset=utf-8"]],
  ["/app-tracking/styles.css", ["styles.css", "text/css"]],
  ["/app-tracking/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);
const server = createServer((request, response) => {
  void (async () => {
    const entry = files.get(new URL(request.url!, "http://localhost").pathname);
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": entry[1] });
    response.end(await readFile(new URL(`../site/${entry[0]}`, import.meta.url)));
  })().catch(() => response.writeHead(500).end());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  const externalRequests: string[] = [];
  const badResponses: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(response.url());
  });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await mkdir("dist/site-evidence", { recursive: true });
  const axe = await readFile(
    new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    "utf8",
  );
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["tablet", 768, 1024],
    ["mobile", 390, 844],
    ["narrow", 320, 740],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/app-tracking/`);
    assert.equal(await page.locator("h1").innerText(), "Your tools.\nYour choice.");
    assert.equal(await page.locator('script, iframe, [src^="http"]').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(await page.context().cookies(), []);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${name}: horizontal overflow`,
    );

    const missingAnchors = await page
      .locator('a[href^="#"]')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute("href")!.slice(1))
          .filter((id) => !document.getElementById(id)),
      );
    assert.deepEqual(missingAnchors, [], `${name}: broken section links`);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").innerText(), "Skip to content");
    const question = page.getByText("Does visiting this page opt me in?", { exact: true });
    await question.focus();
    await page.keyboard.press("Enter");
    assert.equal(await question.locator("..").getAttribute("open"), "");
    await page
      .getByText("This page cannot change your tool’s settings", { exact: false })
      .waitFor();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `dist/site-evidence/${name}.png`, fullPage: true });

    // Inject the local audit tool only in this test; the delivered site has no script.
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => {
      const audit = (
        window as unknown as {
          axe: {
            run: (options: object) => Promise<{
              violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
            }>;
          };
        }
      ).axe;
      return (
        await audit.run({
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] },
        })
      ).violations;
    });
    assert.deepEqual(violations, [], `${name}: accessibility violations`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/app-tracking/`);
  await page.screenshot({ path: "dist/site-evidence/desktop-first-screen.png" });
  // The page must remain usable with JavaScript disabled.
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noScript.newPage();
  await staticPage.goto(`${origin}/app-tracking/`);
  await staticPage.getByText("Are update checks a usage report?", { exact: true }).click();
  await staticPage
    .getByText("No. Version checks use a separate public endpoint", { exact: false })
    .waitFor();
  await noScript.close();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(badResponses, []);
  assert.deepEqual(errors, []);
  console.log(
    "Website verified: four viewports, keyboard FAQ, no-script fallback, local assets, no browser storage or external requests, and axe accessibility checks.",
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
