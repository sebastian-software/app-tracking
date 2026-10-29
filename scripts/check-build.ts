import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { metricsDocument, NOW, path, request, versionFixture } from "../test/helpers.ts";

type Handler = (request: Request) => Promise<Response>;
let handle: Handler | undefined;
let requests = 0;
const environment = new Map<string, string>();
let databaseRequests = 0;
const background: Promise<unknown>[] = [];
const bundle = await readFile("dist/edge.js", "utf8");
runInNewContext(bundle, {
  Bunny: {
    v1: {
      waitUntil(work: Promise<unknown>) {
        background.push(work);
      },
      serve(value: Handler) {
        handle = value;
      },
    },
  },
  Request,
  Response,
  Headers,
  URL,
  TextEncoder,
  TextDecoder,
  btoa,
  atob,
  CryptoKey,
  structuredClone,
  AbortController,
  AbortSignal,
  URLSearchParams,
  performance,
  Deno: { env: { get: (name: string) => environment.get(name) } },
  crypto,
  setTimeout,
  clearTimeout,
  Date: class extends Date {
    static now() {
      return NOW;
    }
  },
  fetch: async (input: RequestInfo | URL) => {
    if (String(input).includes("fixture.pg.psdb.cloud")) {
      databaseRequests++;
      throw new Error("synthetic database outage");
    }
    requests++;
    return Response.json(metricsDocument());
  },
});
assert.ok(handle, "The shipped SDK must register the HTTP handler through Bunny.v1.serve");
assert.equal(requests, 0, "Importing the bundle must not start a network request");
const version = await handle(request(path));
assert.equal(version.status, 200);
assert.deepEqual(await version.json(), versionFixture());
assert.equal((await handle(request("/v1/versions/dalo/standalone/stable"))).status, 200);
assert.equal((await handle(request("/health"))).headers.get("cache-control"), "no-store");
assert.equal(requests, 2);
assert.equal((await handle(request("/v1/usage-batches", { method: "POST" }))).status, 404);
environment.set("APP_TRACKING_TELEMETRY_ENABLED", "1");
environment.set("APP_TRACKING_DATABASE_URL", "synthetic invalid secret");
assert.equal((await handle(request("/v1/usage-batches", { method: "POST" }))).status, 503);
assert.equal((await handle(request(path))).status, 200);
assert.equal((await handle(request("/health"))).status, 200);
assert.equal(requests, 2, "Invalid telemetry configuration must not query storage or versions");
environment.set(
  "APP_TRACKING_DATABASE_URL",
  "postgresql://fixture:fixture@fixture.pg.psdb.cloud/app_tracking",
);
const privatePath = "/v1/installations/00000000-0000-7000-8000-000000000001";
assert.equal((await handle(request(privatePath, { method: "DELETE" }))).status, 401);
const failure = await handle(
  request(privatePath, {
    method: "DELETE",
    headers: { authorization: `Bearer ${"0".repeat(64)}` },
  }),
);
assert.equal(failure.status, 503);
assert.ok(!(await failure.text()).includes("outage"));
assert.equal(databaseRequests, 1);
assert.equal((await handle(request(path))).status, 200);
assert.equal((await handle(request("/health"))).status, 200);
environment.set("APP_TRACKING_TELEMETRY_ENABLED", "0");
assert.equal((await handle(request(privatePath, { method: "DELETE" }))).status, 404);
const reportingPath = "/v1/admin/usage?from=2026-10-01&until=2026-10-28";
assert.equal((await handle(request("/admin"))).status, 404);
environment.set("APP_TRACKING_REPORTING_ENABLED", "1");
assert.equal((await handle(request(reportingPath))).status, 503);
assert.equal((await handle(request("/health"))).status, 200);
environment.set(
  "APP_TRACKING_REPORTING_DATABASE_URL",
  "postgresql://fixture_reporter:fixture@fixture.pg.psdb.cloud/app_tracking",
);
environment.set("APP_TRACKING_WORKOS_CLIENT_ID", "client_fixture");
environment.set("APP_TRACKING_WORKOS_API_KEY", "sk_fixture_key_123");
environment.set("APP_TRACKING_WORKOS_ORGANIZATION_ID", "org_fixture");
environment.set("APP_TRACKING_WORKOS_COOKIE_PASSWORD", "1".repeat(64));
environment.set("APP_TRACKING_WORKOS_ISSUER", "https://api.workos.com");
environment.set("APP_TRACKING_REPORTING_ORIGIN", "https://example.com");
assert.equal((await handle(request("/admin"))).status, 200);
const login = await handle(request("/admin/login"));
assert.equal(login.status, 303);
assert.ok(login.headers.getSetCookie()[0]?.includes("HttpOnly"));
assert.equal(new URL(login.headers.get("location")!).origin, "https://api.workos.com");
assert.equal((await handle(request(reportingPath))).status, 401);
assert.equal(
  databaseRequests,
  1,
  "No unauthenticated reporting request may construct a database query",
);
const report = await handle(
  request(reportingPath, { headers: { authorization: `Bearer at_admin_v1_${"a".repeat(64)}` } }),
);
assert.equal(report.status, 401);
assert.match(report.headers.get("cache-control")!, /no-store/);
assert.ok(!(await report.text()).includes("outage"));
assert.equal(databaseRequests, 1);
assert.equal((await handle(request(path))).status, 200);
environment.set("APP_TRACKING_REPORTING_ENABLED", "0");
assert.equal((await handle(request(reportingPath))).status, 404);
environment.set("APP_TRACKING_SERVICE_METRICS_ENABLED", "1");
const before = databaseRequests;
assert.equal((await handle(request(path, { headers: { DNT: "1" } }))).status, 200);
assert.equal(background.length, 0);
assert.equal(databaseRequests, before);
assert.equal((await handle(request(path))).status, 200);
await Promise.all(background);
assert.equal(background.length, 1);
assert.equal(databaseRequests, before + 1);
assert.equal((await handle(request("/health"))).status, 200);
assert.equal(background.length, 1);
console.log(
  "Deployment bundle: SDK registration, version contract, and health passed (local runtime harness).",
);
