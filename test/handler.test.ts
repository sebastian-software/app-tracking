import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/handler.ts";
import { metricsDocument, NOW, path, request, versionFixture } from "./helpers.ts";

test("oss-metrics returns the complete version contract without reporting fields or forwarded credentials", async () => {
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://metrics.sebastian-software.com/v1/metrics.json");
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
      return Response.json(metricsDocument());
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

test("all installation routes use the same GitHub release metadata", async () => {
  const calls: string[] = [];
  const handle = createHandler({
    now: () => NOW,
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(metricsDocument());
    },
  });
  for (const distribution of ["github", "npm", "standalone"]) {
    const response = await handle(request(`/v1/versions/dalo/${distribution}/stable`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...versionFixture(), distribution });
  }
  for (const distribution of ["github", "npm"]) {
    const response = await handle(request(`/v1/versions/palamedes/${distribution}/stable`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...versionFixture(),
      distribution,
      tool_id: "palamedes",
      latest_version: "2.3.4",
      release_url: "https://github.com/sebastian-software/palamedes/releases/tag/palamedes-v2.3.4",
    });
  }
  assert.ok(calls.every((url) => url === "https://metrics.sebastian-software.com/v1/metrics.json"));
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
      return Response.json(metricsDocument("1.2.3", new Date(now).toISOString()));
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
      return failing ? new Response(null, { status: 503 }) : Response.json(metricsDocument());
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
      return Response.json(metricsDocument());
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
  complete(Response.json(metricsDocument()));
  for (const response of await Promise.all(responses))
    assert.deepEqual(await response.json(), versionFixture());
  assert.equal(calls, 1);
});

test("eviction or a new isolate has no guaranteed stale fallback", async () => {
  const warm = createHandler({
    now: () => NOW,
    fetch: async () => Response.json(metricsDocument()),
  });
  assert.equal((await warm(request())).status, 200);
  const cold = createHandler({
    now: () => NOW,
    fetch: async () => new Response(null, { status: 429 }),
  });
  assert.equal((await cold(request())).status, 503);
});

test("invalid, expired, future, and unsuccessful metrics snapshots are unavailable", async () => {
  const valid = metricsDocument();
  const cases: unknown[] = [
    {},
    { ...valid, schema: 2 },
    { ...valid, sources: { github: "ok", releases: "skipped" } },
    { ...valid, sources: { github: "error", releases: "ok" } },
    { ...valid, github: {} },
    { ...valid, generatedAt: "2026-02-30T08:00:00Z" },
    { ...valid, generatedAt: new Date(NOW + 1).toISOString() },
    { ...valid, generatedAt: "2026-10-21T07:59:59.000Z" },
    { ...valid, generatedAt: new Date(NOW - 86_400_000).toISOString() },
    { ...valid, generatedAt: new Date(NOW - 86_400_001).toISOString() },
  ];
  for (const release of [
    {
      tag: "dalo-v1.2.3-rc.1",
      version: "1.2.3-rc.1",
      publishedAt: valid.github.dalo.release.publishedAt,
    },
    { ...valid.github.dalo.release, tag: "other-v1.2.3" },
    { ...valid.github.dalo.release, version: "01.2.3" },
    { ...valid.github.dalo.release, publishedAt: null },
    { ...valid.github.dalo.release, publishedAt: new Date(NOW - 3_599_999).toISOString() },
  ])
    cases.push({ ...valid, github: { dalo: { release } } });
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

test("the release becomes eligible exactly one hour after publication", async () => {
  let now = NOW;
  const document = metricsDocument();
  document.github.dalo.release.publishedAt = new Date(NOW - 3_599_999).toISOString();
  const handle = createHandler({ now: () => now, fetch: async () => Response.json(document) });
  assert.equal((await handle(request())).status, 503);
  now += 60_000; // Respect failure suppression before the next lookup.
  assert.equal((await handle(request())).status, 200);
  document.github.dalo.release.publishedAt = new Date(NOW - 3_600_000).toISOString();
  const boundary = createHandler({ now: () => NOW, fetch: async () => Response.json(document) });
  assert.equal((await boundary(request())).status, 200);
});

test("stale CDN snapshots keep their collection time and are retried at most once a minute", async () => {
  let now = NOW;
  let calls = 0;
  const document = metricsDocument("1.2.3", new Date(NOW - 3_600_000).toISOString());
  const handle = createHandler({
    now: () => now,
    fetch: async () => {
      calls++;
      return Response.json(document);
    },
  });
  const first = await handle(request());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), {
    ...versionFixture(),
    checked_at: document.generatedAt,
    stale: true,
  });
  assert.equal((await handle(request())).status, 200);
  assert.equal(calls, 1);
  now += 60_000;
  assert.equal((await handle(request())).status, 200);
  assert.equal(calls, 2);
  now = Date.parse(document.generatedAt) + 86_400_000;
  assert.equal((await handle(request())).status, 503);
});

test("a fresh cached upstream document gets only its remaining snapshot lifetime", async () => {
  const generatedAt = new Date(NOW - 1_800_000).toISOString();
  const handle = createHandler({
    now: () => NOW,
    fetch: async () => Response.json(metricsDocument("1.2.3", generatedAt)),
  });
  const response = await handle(request());
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=0, s-maxage=1800, must-revalidate",
  );
  assert.equal((await response.json()).checked_at, generatedAt);
});

test("a recent release retains a previous observation without resetting its age", async () => {
  let now = NOW;
  let document = metricsDocument();
  const handle = createHandler({ now: () => now, fetch: async () => Response.json(document) });
  assert.equal((await handle(request())).status, 200);
  now += 3_600_000;
  document = metricsDocument("1.2.4", new Date(now).toISOString());
  document.github.dalo.release.publishedAt = new Date(now - 900_000).toISOString();
  const previous = await handle(request());
  assert.deepEqual(await previous.json(), { ...versionFixture(), stale: true });
  now += 2_700_000;
  const mature = await handle(request());
  const body = await mature.json();
  assert.equal(body.latest_version, "1.2.4");
  assert.equal(body.checked_at, document.generatedAt);
});

test("an upstream 5xx retries once; 404 and 429 do not retry in the request", async () => {
  for (const status of [404, 429, 500, 503]) {
    let calls = 0;
    const handle = createHandler({
      now: () => NOW,
      retryDelayMs: 0,
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response(null, { status }) : Response.json(metricsDocument());
      },
    });
    const response = await handle(request());
    assert.equal(response.status, status >= 500 ? 200 : 503);
    assert.equal(calls, status >= 500 ? 2 : 1);
  }
});

test("an empty query is canonicalized to the same version resource", async () => {
  const handle = createHandler({
    now: () => NOW,
    fetch: async () => Response.json(metricsDocument()),
  });
  const response = await handle(request(path + "?"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), versionFixture());
});
