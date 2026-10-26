import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { metricsDocument, NOW, path, request, versionFixture } from "../test/helpers.ts";

type Handler = (request: Request) => Promise<Response>;
let handle: Handler | undefined;
let requests = 0;
const environment = new Map<string, string>();
let databaseRequests = 0;
const bundle = await readFile("dist/edge.js", "utf8");
runInNewContext(bundle, {
  Bunny: {
    v1: {
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
console.log(
  "Deployment bundle: SDK registration, version contract, and health passed (local runtime harness).",
);
