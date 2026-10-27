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

test("generic event probe verifies receipts and removes its owned contributions", async () => {
  const { verifyEvents } = await import("../scripts/verify-events.ts");
  const { createEventHandler } = await import("../src/telemetry/events.ts");
  const original = globalThis.fetch;
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "app-tracking-event-probe-"));
  let credential: string | null = null;
  let digest: string | null = null;
  let active = true;
  let contributions = 0;
  let accepted = 0;
  const handler = createEventHandler({
    async submitEvents(batch, hash, token) {
      if (!active) return { result: { error: "installation_revoked" } };
      if (credential && credential !== token) return { result: { error: "unauthorized" } };
      if (digest && digest !== hash) return { result: { error: "batch_conflict" } };
      if (digest) return { result: { status: "duplicate" } };
      credential = token;
      digest = hash;
      contributions += Number(batch.rows[0]!.count);
      accepted++;
      return { result: { status: "accepted" } };
    },
    async deleteEvents(_tool, _id, token) {
      if (token !== credential) return { result: { error: "unauthorized" } };
      contributions = 0;
      active = false;
      return { result: { status: "deleted" } };
    },
  });
  globalThis.fetch = (input, init) => handler(new Request(input, init));
  try {
    process.chdir(directory);
    assert.equal((await verifyEvents()).replay, true);
    assert.equal(accepted, 1);
    assert.equal(contributions, 0);
    await assert.rejects(access(".deployment/event-probe.json"));
  } finally {
    process.chdir(cwd);
    globalThis.fetch = original;
    await rm(directory, { recursive: true });
  }
});

test("generic event cleanup retains authority for an unrecognized routing 404", async () => {
  const { saveEventProbe, cleanupEventProbe, EVENT_PROBE_BASE } =
    await import("../scripts/verify-events.ts");
  const original = globalThis.fetch;
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "app-tracking-event-cleanup-"));
  try {
    process.chdir(directory);
    await saveEventProbe({
      base: EVENT_PROBE_BASE,
      tool: "ferriki",
      id: "a".repeat(64),
      token: "b".repeat(64),
    });
    globalThis.fetch = async () =>
      Response.json(
        { error: { code: "not_found" } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    await assert.rejects(cleanupEventProbe());
    await access(".deployment/event-probe.json");
    globalThis.fetch = async () =>
      Response.json(
        { error: { code: "installation_not_found" } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    await cleanupEventProbe();
    await assert.rejects(access(".deployment/event-probe.json"));
  } finally {
    process.chdir(cwd);
    globalThis.fetch = original;
    await rm(directory, { recursive: true });
  }
});
