import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTelemetry } from "../scripts/verify-telemetry.ts";
import { createTelemetryHandler } from "../src/telemetry/handler.ts";

test("live probe removes its owned identity after a database failure", async () => {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "app-tracking-probe-test-"));
  const original = globalThis.fetch;
  let deleted = false;
  const handler = createTelemetryHandler({
    registerV1: async () => ({ result: { status: "registered" }, subrequests: 1, database_ms: 0 }),
    submitV1: async () => {
      throw new Error("synthetic private database failure");
    },
    deleteV1: async () => {
      deleted = true;
      return { result: { status: "deleted" }, subrequests: 1, database_ms: 0 };
    },
  });
  let registration = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await handler(request);
    if (request.method === "PUT" && ++registration > 1)
      return Response.json({ status: "duplicate" }, { headers: { "Cache-Control": "no-store" } });
    return response;
  };
  try {
    process.chdir(directory);
    await assert.rejects(verifyTelemetry());
    assert.equal(deleted, true);
    await assert.rejects(access(".deployment/telemetry-probe.json"));
  } finally {
    process.chdir(cwd);
    globalThis.fetch = original;
    await rm(directory, { recursive: true });
  }
});
