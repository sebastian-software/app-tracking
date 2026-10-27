import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Serve the exact Pages artifact under its repository prefix to catch broken assets.
const files = new Map([
  ["/app-tracking/", ["index.html", "text/html; charset=utf-8"]],
  ["/app-tracking/styles.css", ["styles.css", "text/css"]],
  ["/app-tracking/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/app-tracking/redirect.js", ["redirect.js", "text/javascript"]],
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
  const canonical = "https://app-tracking.sebastian-software.com/";
  const redirectContext = await browser.newContext();
  const redirectPage = await redirectContext.newPage();
  const redirectRequests: string[] = [];
  await redirectPage.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(canonical).origin) {
      redirectRequests.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "<h1>Destination</h1>" });
    }
    if (url.origin === origin) return route.continue();
    throw new Error(`Unexpected redirect request: ${url.href}`);
  });
  for (const hash of ["", "#data", "#controls", "#privacy", "#questions", "#custom-section"]) {
    await redirectPage.goto(`${origin}/app-tracking/?discard=this${hash}`);
    await redirectPage.waitForURL(`${canonical}${hash}`);
    assert.equal(redirectPage.url(), `${canonical}${hash}`);
  }
  assert.equal(redirectRequests.length, 6);
  assert.deepEqual(await redirectContext.cookies(), []);
  await redirectContext.close();

  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noScript.newPage();
  await staticPage.goto(`${origin}/app-tracking/#privacy`);
  assert.equal(await staticPage.getByRole("link", { name: "Continue in English" }).count(), 1);
  assert.equal(await staticPage.getByRole("link", { name: "Read the German version" }).count(), 1);
  await noScript.close();

  // Keep JavaScript available for axe's timers, but prevent the redirect during audits.
  const fallback = await browser.newContext();
  const page = await fallback.newPage();
  const errors: string[] = [];
  const externalRequests: string[] = [];
  const badResponses: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(response.url());
  });
  await page.route("**/*", (route) => {
    if (route.request().url() === `${origin}/app-tracking/redirect.js`) {
      return route.fulfill({ contentType: "text/javascript", body: "" });
    }
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
    assert.equal(await page.locator("h1").innerText(), "The app-tracking website has moved.");
    assert.equal(await page.locator('iframe, [src^="http"]').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(await page.context().cookies(), []);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${name}: horizontal overflow`,
    );

    assert.equal(
      await page.getByRole("link", { name: "Continue in English" }).getAttribute("href"),
      canonical,
    );
    assert.equal(
      await page.getByRole("link", { name: "Read the German version" }).getAttribute("href"),
      "https://app-tracking.sebastian-software.de/",
    );
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").innerText(), "Continue in English");
    await page.screenshot({ path: `dist/site-evidence/${name}.png`, fullPage: true });

    // The audit tool is local and is never part of the delivered page.
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
  await fallback.close();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(badResponses, []);
  assert.deepEqual(errors, []);
  console.log(
    "Compatibility page verified: canonical redirects with preserved fragments and discarded queries; no-script links; accessible fallback at four viewports; no cookies, browser storage, or unexpected requests.",
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
