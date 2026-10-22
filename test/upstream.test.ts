import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { createHandler } from "../src/handler.ts";
import { MAX_UPSTREAM_BYTES } from "../src/upstream.ts";
import { npmDocument, NOW, request } from "./helpers.ts";

async function serverFor(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("the real HTTP transport parses npm JSON without forwarding incoming headers", async (t) => {
  const base = await serverFor(t, (req, res) => {
    assert.equal(req.url, "/getdalo");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(npmDocument()));
  });
  const handle = createHandler({
    now: () => NOW,
    fetch: (url, init) => {
      const upstream = new URL(String(url));
      return fetch(base + upstream.pathname, init);
    },
  });
  const response = await handle(
    request(undefined, { headers: { authorization: "Bearer synthetic", cookie: "synthetic=1" } }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).latest_version, "1.2.3");
});

test("redirects cannot fetch another location", async (t) => {
  let redirectsFollowed = 0;
  const base = await serverFor(t, (req, res) => {
    if (req.url === "/trap") {
      redirectsFollowed++;
      res.end("forbidden");
      return;
    }
    res.writeHead(302, { Location: "/trap" });
    res.end();
  });
  const handle = createHandler({
    now: () => NOW,
    retryDelayMs: 0,
    fetch: (_url, init) => fetch(base, init),
  });
  assert.equal((await handle(request())).status, 503);
  assert.equal(redirectsFollowed, 0);
});

for (const phase of ["headers", "body"]) {
  test(`timeout aborts a real HTTP request stalled at ${phase} and bounds retries`, async (t) => {
    const base = await serverFor(t, (_req, res) => {
      if (phase === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"name":');
      }
    });
    const signals: AbortSignal[] = [];
    const handle = createHandler({
      now: () => NOW,
      timeoutMs: 100,
      retryDelayMs: 0,
      fetch: (_url, init) => {
        assert.ok(init?.signal);
        signals.push(init.signal);
        return fetch(base, init);
      },
    });
    assert.equal((await handle(request())).status, 503);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
  });
}

test("the streamed body limit applies without trusting Content-Length", async () => {
  let cancelled = false;
  let chunks = 0;
  let calls = 0;
  const handle = createHandler({
    now: () => NOW,
    fetch: async () => {
      calls++;
      return new Response(
        new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(65_536));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal((await handle(request())).status, 503);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.ok(
    chunks <= MAX_UPSTREAM_BYTES / 65_536 + 2,
    "Reading must stop at the bound plus stream buffering",
  );
});

test("oversized declarations, non-JSON, truncated JSON, and invalid UTF-8 are rejected without retry", async () => {
  const responses = [
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_UPSTREAM_BYTES + 1),
      },
    }),
    new Response("<html>not registry metadata</html>", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response('{"name":', { headers: { "Content-Type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }),
  ];
  for (const upstream of responses) {
    let calls = 0;
    const handle = createHandler({
      now: () => NOW,
      fetch: async () => {
        calls++;
        return upstream;
      },
    });
    assert.equal((await handle(request())).status, 503);
    assert.equal(calls, 1);
  }
});
