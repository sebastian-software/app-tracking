import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../src/handler.ts";
import { createServiceMetrics, type VersionObservation } from "../src/service-metrics.ts";
import { metricsDocument, NOW, path, request } from "./helpers.ts";

test("functional version statistics contain only reviewed route and response categories", async () => {
  const observations: VersionObservation[] = [];
  const handle = createHandler(
    { now: () => NOW, fetch: async () => Response.json(metricsDocument()) },
    (value) => {
      observations.push(value);
    },
  );
  const response = await handle(
    request(path, {
      headers: {
        "X-Forwarded-For": "192.0.2.10",
        "User-Agent": "private-device",
        Cookie: "private=1",
        Authorization: "Bearer private",
        "X-Installation-ID": "private",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(observations, [
    { tool: "dalo", distribution: "npm", channel: "stable", status: 200 },
  ]);
  assert.equal(
    (await handle(request(path, { headers: { "If-None-Match": response.headers.get("etag")! } })))
      .status,
    304,
  );
  assert.equal(observations[1]?.status, 304);
  for (const name of ["DNT", "Sec-GPC"])
    assert.equal((await handle(request(path, { headers: { [name]: "1" } }))).status, 200);
  for (const route of ["/health", path + "?private=1", "/v1/versions/private/npm/stable", "/admin"])
    await handle(request(route));
  assert.equal(observations.length, 2);
  const unavailable = createHandler(
    { now: () => NOW, fetch: async () => new Response(null, { status: 404 }) },
    (value) => {
      observations.push(value);
    },
  );
  assert.equal((await unavailable(request(path))).status, 503);
  assert.equal(observations[2]?.status, 503);
  const throwing = createHandler(
    { now: () => NOW, fetch: async () => Response.json(metricsDocument()) },
    () => {
      throw new Error("statistics unavailable");
    },
  );
  assert.equal((await throwing(request(path))).status, 200);
});

test("statistics do not wait for writes, bound pending work, and recover after failure", async () => {
  const work: Promise<unknown>[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const observer = createServiceMetrics(
    () => ({
      async countVersionRequest(value, signal) {
        calls++;
        assert.deepEqual(Object.keys(value).sort(), ["channel", "distribution", "status", "tool"]);
        assert.ok(signal instanceof AbortSignal);
        await blocked;
        throw new Error("synthetic storage outage");
      },
    }),
    (pending) => {
      work.push(pending);
    },
  );
  const handle = createHandler(
    { now: () => NOW, fetch: async () => Response.json(metricsDocument()) },
    observer,
  );
  for (let i = 0; i < 10; i++) assert.equal((await handle(request(path))).status, 200);
  assert.equal(calls, 8);
  assert.equal(work.length, 8);
  release();
  await Promise.all(work);
  assert.equal((await handle(request(path))).status, 200);
  await Promise.all(work);
  assert.equal(calls, 9);
});
