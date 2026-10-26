import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { record } from "../src/telemetry/contract.ts";
const fixture = JSON.parse(await readFile("test/fixtures/telemetry/valid.json", "utf8"));
const calls: { query: string; params: unknown[] }[] = [];
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://fixture.pg.psdb.cloud/sql");
  const call = JSON.parse(String(init?.body));
  calls.push(call);
  const result = call.query.includes("register_installation_v1")
    ? { status: "registered" }
    : call.query.includes("delete_installation_v1")
      ? { status: "deleted" }
      : { status: "accepted", received_at: fixture.now };
  return Response.json({
    fields: [{ name: "result", dataTypeID: 3802 }],
    rows: [[JSON.stringify(result)]],
    rowCount: 1,
    command: "SELECT",
    rowAsArray: true,
  });
};
try {
  const candidate: unknown = await import(
    new URL("../dist/telemetry-candidate.js", import.meta.url).href
  );
  assert.ok(record(candidate) && typeof candidate.createTelemetryService === "function");
  const handle: unknown = candidate.createTelemetryService(
    "postgresql://synthetic:synthetic@fixture.pg.psdb.cloud/app_tracking",
  );
  assert.equal(calls.length, 0, "Construction must not register or collect anything");
  assert.ok(typeof handle === "function");
  const token = "0123456789abcdef".repeat(4);
  const request = (path: string, body: unknown, method: string) =>
    new Request(`https://example.invalid${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const reg = await handle(
    request(`/v1/installations/${fixture.installation_id}`, fixture.registration, "PUT"),
  );
  assert.ok(reg instanceof Response);
  assert.equal(reg.status, 201);
  const ack = await handle(request("/v1/usage-batches", fixture.batch, "POST"));
  assert.ok(ack instanceof Response);
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).payload_sha256, fixture.payload_sha256);
  assert.equal(calls.length, 2);
  assert.match(calls[1].query, /accept_batch_v1\(\$1,/);
  assert.equal(calls[1].params.length, 7);
  assert.equal(
    calls[1].params[2],
    createHash("sha256")
      .update(`app-tracking-token-v1\n${fixture.installation_id}\n${token}`)
      .digest("hex"),
  );
  assert.equal(calls[1].params[4], fixture.payload_sha256);
  assert.ok(!JSON.stringify(calls).includes(token));
  const deleted = await handle(
    new Request(`https://example.invalid/v1/installations/${fixture.installation_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.ok(deleted instanceof Response);
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");
  assert.equal(calls.length, 3);
  assert.match(calls[2].query, /delete_installation_v1\(\$1,/);
  assert.equal(calls[2].params.length, 3);
  const meta = JSON.parse(await readFile("dist/edge.meta.json", "utf8"));
  assert.ok(
    Object.keys(meta.inputs).some((p) => p.includes("/telemetry/")) &&
      Object.keys(meta.inputs).some((p) => p.includes("/storage/")),
    "Production bundle must include the explicitly gated telemetry service",
  );
  console.log(
    "Telemetry candidate bundle: fixed wire acknowledgements, parameterized HTTP calls, credential hashing, and production isolation passed.",
  );
} finally {
  globalThis.fetch = original;
}
