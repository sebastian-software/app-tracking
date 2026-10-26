import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../src/service.ts";
import { metricsDocument, NOW, path, request } from "./helpers.ts";

test("database configuration failure cannot affect version or health routes", async () => {
  let construction = 0;
  const handle = createService(
    () => {
      construction++;
      throw new Error("synthetic private configuration");
    },
    { now: () => NOW, fetch: async () => Response.json(metricsDocument()) },
  );
  assert.equal((await handle(request(path))).status, 200);
  assert.equal((await handle(request("/health"))).status, 200);
  assert.equal((await handle(request("/v1/admin/usage"))).status, 404);
  assert.equal(construction, 0);
  const response = await handle(request("/v1/usage-batches", { method: "POST" }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!(await response.text()).includes("private"));
  assert.equal(construction, 1);
});

test("runtime switch closes all telemetry methods without constructing storage", async () => {
  const handle = createService(() => undefined);
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const response = await handle(request("/v1/usage-batches", { method }));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
