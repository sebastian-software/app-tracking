import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { canonical, sha256 } from "../src/telemetry/contract.ts";
import type { EventBatch } from "../src/telemetry/events.ts";

export const EVENT_PROBE_BASE = "https://sebastian-app-tracking.b-cdn.net";
const statePath = ".deployment/event-probe.json";
export interface EventProbe {
  id: string;
  token: string;
  tool: "ferriki";
  base: string;
}
function validate(probe: EventProbe) {
  assert.ok(probe.base === EVENT_PROBE_BASE && probe.tool === "ferriki");
  assert.ok(/^[0-9a-f]{64}$/.test(probe.id) && /^[0-9a-f]{64}$/.test(probe.token));
}
export async function saveEventProbe(probe: EventProbe) {
  validate(probe);
  await mkdir(".deployment", { recursive: true, mode: 0o700 });
  // Never overwrite an interrupted run's pending cleanup authority.
  await writeFile(statePath, JSON.stringify(probe), { mode: 0o600, flag: "wx" });
}
async function send(probe: EventProbe, method: string, body?: EventBatch) {
  validate(probe);
  const path = method === "DELETE" ? `/v1/event-installations/${probe.id}` : "/v1/event-batches";
  const response = await fetch(new URL(path, probe.base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${probe.token}`,
      "App-Tracking-Tool": probe.tool,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.notEqual(response.headers.get("cdn-cache")?.toUpperCase(), "HIT");
  assert.ok(Number(response.headers.get("content-length") ?? 0) <= 2048);
  return response;
}
export async function cleanupEventProbe() {
  let probe: EventProbe;
  try {
    probe = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Event probe cleanup state unavailable");
  }
  validate(probe);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await send(probe, "DELETE");
    if (response.status === 204) {
      assert.equal(await response.text(), "");
      await rm(statePath);
      return;
    }
    if (response.status === 404) {
      assert.ok((await response.json()).error?.code === "installation_not_found");
      await rm(statePath);
      return;
    }
    assert.ok([202, 429, 503].includes(response.status));
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Event probe deletion remains pending");
}
export async function verifyEvents() {
  await cleanupEventProbe();
  const probe: EventProbe = {
    id: randomBytes(32).toString("hex"),
    token: randomBytes(32).toString("hex"),
    tool: "ferriki",
    base: EVENT_PROBE_BASE,
  };
  await saveEventProbe(probe);
  try {
    const batch: EventBatch = {
      schema_version: 1,
      tool_id: probe.tool,
      batch_id: randomBytes(32).toString("hex"),
      collection: "opt_in",
      mode: "ci",
      installation_id: probe.id,
      consented_at: Date.now(),
      rows: [
        {
          day: Math.floor(Date.now() / 86400000),
          metric: "language.use",
          collection: "opt_in",
          tool_version: "0.0.0-app-tracking-probe",
          dimensions: { language: "rust", source: "explicit" },
          count: 1,
          system: { os: "other", os_version: "unknown", arch: "other", cpu_family: "unknown" },
        },
      ],
    };
    const digest = await sha256(canonical(batch));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(probe, "POST", batch);
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.ok(Object.keys(receipt).sort().join() === "batch_id,payload_sha256");
      assert.ok(receipt.batch_id === batch.batch_id && receipt.payload_sha256 === digest);
    }
    const changed = structuredClone(batch);
    changed.rows[0]!.count = 2;
    const conflict = await send(probe, "POST", changed);
    assert.equal(conflict.status, 409);
    assert.ok((await conflict.json()).error?.code === "batch_conflict");
    const denied = await send({ ...probe, token: "0".repeat(64) }, "DELETE");
    assert.equal(denied.status, 401);
    assert.ok((await denied.json()).error?.code === "unauthorized");
    await cleanupEventProbe();
    const revoked = await send(probe, "POST", batch);
    assert.equal(revoked.status, 410);
    assert.ok((await revoked.json()).error?.code === "installation_revoked");
    return {
      event_ingestion: true,
      replay: true,
      conflict: true,
      credential_scope: true,
      deletion: true,
      private_cache_bypass: true,
    };
  } finally {
    await cleanupEventProbe();
  }
}
if (import.meta.main) {
  try {
    if (process.argv.includes("--cleanup")) await cleanupEventProbe();
    else console.log(JSON.stringify(await verifyEvents()));
  } catch {
    console.error(
      "Generic event probe failed; no credentials, identifiers, reports, or provider details were logged.",
    );
    process.exitCode = 1;
  }
}
