import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/handler.ts";
import { githubDocument, npmDocument, NOW, path, request, versionFixture } from "./helpers.ts";

test("npm returns the complete version contract without reporting fields or forwarded credentials", async () => {
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://registry.npmjs.org/getdalo");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("x-installation-id"), null);
      assert.equal(
        headers.get("user-agent"),
        "app-tracking (https://github.com/sebastian-software/app-tracking)",
      );
      return Response.json(npmDocument());
    },
  });
  const response = await handle(
    request(path, {
      headers: {
        Authorization: "Bearer synthetic-client-credential",
        Cookie: "synthetic=1",
        "X-Installation-ID": "synthetic",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), versionFixture());
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=3600, must-revalidate",
  );
  assert.match(response.headers.get("etag") ?? "", /^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("scoped Palamedes metadata uses its npm package and npm publication time", async () => {
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url) => {
      assert.equal(String(url), "https://registry.npmjs.org/%40palamedes%2Fcli");
      return Response.json(npmDocument("@palamedes/cli", "2.3.4"));
    },
  });
  const response = await handle(request("/v1/versions/palamedes/npm/stable"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...versionFixture(),
    tool_id: "palamedes",
    latest_version: "2.3.4",
    release_url: "https://www.npmjs.com/package/@palamedes/cli/v/2.3.4",
  });
});

test("standalone releases require binary assets and construct a reviewed release link", async () => {
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url) => {
      assert.equal(
        String(url),
        "https://api.github.com/repos/sebastian-software/dalo/releases/latest",
      );
      return Response.json(githubDocument());
    },
  });
  const response = await handle(request("/v1/versions/dalo/standalone/stable"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...versionFixture(),
    distribution: "standalone",
    release_url: "https://github.com/sebastian-software/dalo/releases/tag/dalo-v1.2.3",
  });
});

test("distribution caches stay independent during publication lag", async () => {
  const calls: string[] = [];
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(
        String(url).includes("api.github.com") ? githubDocument() : npmDocument("getdalo", "1.2.2"),
      );
    },
  });
  assert.equal(
    (await (await handle(request("/v1/versions/dalo/standalone/stable"))).json()).latest_version,
    "1.2.3",
  );
  assert.equal((await (await handle(request())).json()).latest_version, "1.2.2");
  assert.equal((await (await handle(request())).json()).latest_version, "1.2.2");
  assert.equal(calls.length, 2);
});

test("invalid requests and unsupported mappings never perform an upstream lookup", async () => {
  const handle = createHandler({
    fetch: async () => {
      assert.fail("Unexpected upstream request");
    },
  });
  const cases: [string, number, string, RequestInit?][] = [
    [path + "?installed_version=1.0.0", 400, "invalid_request"],
    [path + "?project_id=synthetic", 400, "invalid_request"],
    [path + "?url=https://example.com", 400, "invalid_request"],
    [path + "?", 400, "invalid_request"],
    [path + "/", 404, "not_found"],
    ["/v1/versions/%64alo/npm/stable", 404, "not_found"],
    ["/v1/versions/unknown/npm/stable", 404, "unknown_tool"],
    ["/v1/versions/__proto__/npm/stable", 404, "not_found"],
    ["/v1/versions/dalo/homebrew/stable", 404, "unsupported_distribution"],
    ["/v1/versions/palamedes/standalone/stable", 404, "unsupported_distribution"],
    ["/v1/versions/palamedes/crates/stable", 404, "unsupported_distribution"],
    ["/v1/versions/dalo/npm/beta", 404, "unsupported_channel"],
    ["/check", 404, "not_found"],
    [path, 405, "method_not_allowed", { method: "POST", body: "{}" }],
    [path, 400, "invalid_request", { headers: { "Content-Length": "1" } }],
    [path, 400, "invalid_request", { headers: { "Transfer-Encoding": "chunked" } }],
  ];
  for (const [pathname, status, code, init] of cases) {
    const response = await handle(request(pathname, init));
    assert.equal(response.status, status, pathname);
    assert.equal(response.headers.get("cache-control"), "no-store", pathname);
    assert.deepEqual(await response.json(), { schema_version: 1, error: { code } }, pathname);
    if (status === 405) assert.equal(response.headers.get("allow"), "GET");
  }
  const health = await handle(request("/health"));
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("fresh cache responses reduce remaining CDN lifetime and honor conditional GET", async () => {
  let now = NOW;
  let calls = 0;
  const handle = createHandler({
    now: () => now,
    fetch: async () => {
      calls++;
      return Response.json(npmDocument());
    },
  });
  const initial = await handle(request());
  const etag = initial.headers.get("etag");
  assert.ok(etag);
  now += 1_800_100;
  const cached = await handle(request());
  assert.equal(calls, 1);
  assert.equal(
    cached.headers.get("cache-control"),
    "public, max-age=0, s-maxage=1799, must-revalidate",
  );
  assert.deepEqual(await cached.json(), versionFixture());
  for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
    const conditional = await handle(request(path, { headers: { "If-None-Match": validator } }));
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
    assert.equal(conditional.headers.get("etag"), etag);
    assert.equal(conditional.headers.get("cache-control"), cached.headers.get("cache-control"));
  }
  assert.equal(
    (await handle(request(path, { headers: { "If-None-Match": '"other"' } }))).status,
    200,
  );
  assert.equal(
    (await handle(request(path + "?unexpected=1", { headers: { "If-None-Match": etag } }))).status,
    400,
  );
  now = NOW + 3_600_000;
  const refreshed = await handle(request(path, { headers: { "If-None-Match": etag } }));
  assert.equal(refreshed.status, 200);
  assert.equal(calls, 2);
  assert.notEqual(refreshed.headers.get("etag"), etag);
  assert.equal((await refreshed.json()).checked_at, new Date(now).toISOString());
});

test("outages preserve the original timestamp and stale results expire at 24 hours", async () => {
  let now = NOW;
  let failing = false;
  let calls = 0;
  const handle = createHandler({
    now: () => now,
    retryDelayMs: 0,
    fetch: async () => {
      calls++;
      return failing ? new Response(null, { status: 503 }) : Response.json(npmDocument());
    },
  });
  const first = await handle(request());
  const etag = first.headers.get("etag");
  assert.ok(etag);
  failing = true;
  now += 3_600_000;
  const stale = await handle(request(path, { headers: { "If-None-Match": etag } }));
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { ...versionFixture(), stale: true });
  assert.equal(stale.headers.get("cache-control"), "no-store");
  assert.notEqual(stale.headers.get("etag"), etag);
  assert.equal(calls, 3);
  now += 30_000;
  assert.equal((await handle(request())).status, 200);
  assert.equal(calls, 3, "failure suppression must not reset checked_at or retry on every request");
  now = NOW + 86_400_000 - 1;
  assert.equal((await handle(request())).status, 200);
  now++;
  const expired = await handle(request());
  assert.equal(expired.status, 503);
  assert.equal(expired.headers.get("cache-control"), "no-store");
  assert.equal(expired.headers.get("retry-after"), "60");
  assert.deepEqual(await expired.json(), {
    schema_version: 1,
    error: { code: "release_unavailable" },
  });
});

test("a cold outage is unavailable, suppresses retries for a minute, and recovers", async () => {
  let now = NOW;
  let calls = 0;
  let failing = true;
  const handle = createHandler({
    now: () => now,
    retryDelayMs: 0,
    fetch: async () => {
      calls++;
      if (failing) throw new Error("synthetic detail must not escape");
      return Response.json(npmDocument());
    },
  });
  const unavailable = await handle(request());
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /synthetic/);
  assert.equal(calls, 2);
  assert.equal((await handle(request())).status, 503);
  assert.equal(calls, 2);
  now += 60_000;
  failing = false;
  assert.equal((await handle(request())).status, 200);
  assert.equal(calls, 3);
});

test("concurrent cold requests share one lookup", async () => {
  let calls = 0;
  let complete: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const handle = createHandler({
    now: () => NOW,
    fetch: async () => {
      calls++;
      return pending;
    },
  });
  const responses = Array.from({ length: 8 }, () => handle(request()));
  assert.equal(calls, 1);
  assert.ok(complete);
  complete(Response.json(npmDocument()));
  for (const response of await Promise.all(responses))
    assert.deepEqual(await response.json(), versionFixture());
  assert.equal(calls, 1);
});

test("eviction or a new isolate has no guaranteed stale fallback", async () => {
  const warm = createHandler({ now: () => NOW, fetch: async () => Response.json(npmDocument()) });
  assert.equal((await warm(request())).status, 200);
  const cold = createHandler({
    now: () => NOW,
    fetch: async () => new Response(null, { status: 429 }),
  });
  assert.equal((await cold(request())).status, 503);
});

test("invalid npm metadata and stable-channel prereleases never become successful responses", async () => {
  const cases: unknown[] = [
    {},
    npmDocument("wrong-package"),
    npmDocument("getdalo", "1.2.3-beta.1"),
    npmDocument("getdalo", "v1.2.3"),
    npmDocument("getdalo", "01.2.3"),
    { ...npmDocument(), versions: {} },
    { ...npmDocument(), time: {} },
    { ...npmDocument(), time: { "1.2.3": "2026-02-30T08:00:00.000Z" } },
    { ...npmDocument(), time: { "1.2.3": "2030-01-01T08:00:00.000Z" } },
    { ...npmDocument(), versions: { "1.2.3": { name: "getdalo", version: "1.2.2" } } },
    {
      ...npmDocument(),
      versions: { "1.2.3": { name: "getdalo", version: "1.2.3", deprecated: "Retired" } },
    },
  ];
  for (const document of cases) {
    let calls = 0;
    const handle = createHandler({
      now: () => NOW,
      fetch: async () => {
        calls++;
        return Response.json(document);
      },
    });
    assert.equal((await handle(request())).status, 503, JSON.stringify(document));
    assert.equal(calls, 1, "invalid documents are not retried");
  }
});

test("draft, prerelease, malformed, and incomplete GitHub releases are unavailable", async () => {
  const valid = githubDocument();
  const cases = [
    { ...valid, draft: true },
    { ...valid, prerelease: true },
    { ...valid, tag_name: "dalo-v1.2.3-rc.1" },
    { ...valid, tag_name: "another-v1.2.3" },
    { ...valid, published_at: null },
    { ...valid, assets: [] },
    { ...valid, assets: valid.assets.slice(1) },
    { ...valid, assets: valid.assets.map((asset) => ({ ...asset, state: "new" })) },
    { ...valid, assets: valid.assets.map((asset) => ({ ...asset, size: 0 })) },
  ];
  for (const document of cases) {
    const handle = createHandler({ now: () => NOW, fetch: async () => Response.json(document) });
    assert.equal((await handle(request("/v1/versions/dalo/standalone/stable"))).status, 503);
  }
});

test("an upstream 5xx retries once; 404 and 429 do not retry in the request", async () => {
  for (const status of [404, 429, 500, 503]) {
    let calls = 0;
    const handle = createHandler({
      now: () => NOW,
      retryDelayMs: 0,
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response(null, { status }) : Response.json(npmDocument());
      },
    });
    const response = await handle(request());
    assert.equal(response.status, status >= 500 ? 200 : 503);
    assert.equal(calls, status >= 500 ? 2 : 1);
  }
});
