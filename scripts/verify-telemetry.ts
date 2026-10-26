import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { canonicalBatch, sha256, type Batch } from "../src/telemetry/contract.ts";

const statePath = ".deployment/telemetry-probe.json";
const base = "https://sebastian-app-tracking.b-cdn.net";
export interface ProbeTarget {
  base: string;
  proofToken?: string;
}
function uuid7(now = Date.now()) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
interface Probe {
  id: string;
  token: string;
  target: ProbeTarget;
}
function checkTarget(target: ProbeTarget) {
  assert.ok(
    target.base === base ||
      /^https:\/\/app-tracking-proof-[a-z0-9-]+\.b-cdn\.net$/.test(target.base),
  );
  if (target.proofToken) assert.match(target.proofToken, /^[0-9a-f]{64}$/);
}
async function send(probe: Probe, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, probe.target.base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${probe.token}`,
      "App-Tracking-Tool": "palamedes",
      ...(probe.target.proofToken ? { "X-App-Tracking-Proof": probe.target.proofToken } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.notEqual(response.headers.get("cdn-cache")?.toUpperCase(), "HIT");
  assert.ok(Number(response.headers.get("content-length") ?? 0) <= 2048);
  return response;
}
export async function cleanupProbe() {
  let probe: Probe;
  try {
    probe = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Probe state is not readable");
  }
  assert.match(probe.id, /^[0-9a-f-]{36}$/);
  assert.match(probe.token, /^[0-9a-f]{64}$/);
  checkTarget(probe.target);
  // Repeating the authenticated delete is safe after an unknown outcome.
  for (let n = 0; n < 5; n++) {
    const response = await send(probe, "DELETE", `/v1/installations/${probe.id}`);
    if (response.status === 204) {
      await response.body?.cancel();
      await rm(statePath);
      return;
    }
    assert.equal(response.status, 503);
    await response.body?.cancel();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Synthetic deletion remains pending");
}
export async function verifyTelemetry(target: ProbeTarget = { base }) {
  checkTarget(target);
  // Never replace pending cleanup authority left by an interrupted probe.
  await cleanupProbe();
  const probe = { id: uuid7(), token: randomBytes(32).toString("hex"), target };
  await mkdir(".deployment", { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(probe), { mode: 0o600, flag: "wx" });
  try {
    const registration = {
      schema_version: 1,
      tool_id: "palamedes",
      consent_revision: "telemetry-v1",
      consented_at: new Date().toISOString(),
      mode: "ci",
    };
    const path = `/v1/installations/${probe.id}`;
    for (const status of [201, 200]) {
      const response = await send(probe, "PUT", path, registration);
      // A lost acknowledgement may have committed the first registration.
      assert.equal(response.status, status);
      assert.equal((await response.json()).status, status === 201 ? "registered" : "duplicate");
    }
    const batch: Batch = {
      schema_version: 1,
      tool_id: "palamedes",
      installation_id: probe.id,
      batch_id: uuid7(),
      consent_revision: "telemetry-v1",
      rows: [
        {
          day: new Date().toISOString().slice(0, 10),
          tool_version: "0.0.0-app-tracking-probe",
          command: "report",
          count: 1,
        },
      ],
    };
    for (const status of ["accepted", "duplicate"]) {
      const response = await send(probe, "POST", "/v1/usage-batches", batch);
      assert.equal(response.status, 200);
      const ack = await response.json();
      assert.equal(ack.status, status);
      assert.equal(ack.payload_sha256, await sha256(canonicalBatch(batch)));
    }
    const changed = structuredClone(batch);
    changed.rows[0].count = 2;
    const conflict = await send(probe, "POST", "/v1/usage-batches", changed);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      schema_version: 1,
      error: { code: "batch_conflict" },
    });
    const denied = await send({ ...probe, token: "0".repeat(64) }, "DELETE", path);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { schema_version: 1, error: { code: "unauthorized" } });
    await cleanupProbe();
    const afterDelete = await send(probe, "POST", "/v1/usage-batches", batch);
    assert.equal(afterDelete.status, 410);
    assert.deepEqual(await afterDelete.json(), {
      schema_version: 1,
      error: { code: "installation_revoked" },
    });
    return {
      registration: true,
      ingestion: true,
      replay: true,
      conflict: true,
      credential_scope: true,
      deletion: true,
      private_cache_bypass: true,
    };
  } finally {
    await cleanupProbe();
  }
}
if (import.meta.main) {
  try {
    if (process.argv.includes("--cleanup")) await cleanupProbe();
    else console.log(JSON.stringify(await verifyTelemetry()));
  } catch {
    console.error(
      "Production telemetry probe failed; inspect operation status privately. No credentials, identifiers, reports, or provider errors were logged.",
    );
    process.exitCode = 1;
  }
}
