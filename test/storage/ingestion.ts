import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { createStorage, type StorageResult } from "../../src/storage/database.ts";
import { createTelemetryHandler, type TelemetryStorage } from "../../src/telemetry/handler.ts";
import {
  canonicalBatch,
  batch as validateBatch,
  sha256,
  policy,
} from "../../src/telemetry/contract.ts";
import { uuid7, maxRows } from "./fixture.ts";

// Faithful HTTP handler + real SQL functions. Live runs select the actual HTTP
// driver; container CI uses the unprivileged psql transport for the same functions.
export async function ingestionIntegration(admin: string, runtime: string) {
  const sql = (text: string) => psql(admin, text);
  const run = async (text: string) => ({
    result: JSON.parse(await psql(runtime, text)) as StorageResult,
    subrequests: 1,
    database_ms: 0,
  });
  const storage: TelemetryStorage =
    process.env.INGESTION_HTTP_DRIVER === "1"
      ? createStorage(runtime)
      : {
          registerV1(tool, id, token, revision, consented, mode) {
            return run(
              `SELECT app_tracking.register_installation_v1(${q(tool)},${q(id)},${q(token)},${q(revision)},${q(consented)},${q(mode)})`,
            );
          },
          submitV1(tool, id, token, batch, hash, revision, rows) {
            return run(
              `SELECT app_tracking.accept_batch_v1(${q(tool)},${q(id)},${q(token)},${q(batch)},${q(hash)},${q(revision)},${q(JSON.stringify(rows))}::jsonb)`,
            );
          },
        };
  const handle = createTelemetryHandler(storage);
  const ids: string[] = [];
  let checks = 0,
    phase = "registration";
  type Item = {
    id: string;
    token: string;
    declaration: {
      schema_version: number;
      tool_id: string;
      consent_revision: string;
      consented_at: string;
      mode: string;
    };
  };
  const identity = (): Item => {
    const item = {
      id: uuid7(),
      token: randomBytes(32).toString("hex"),
      declaration: {
        schema_version: 1,
        tool_id: "dalo",
        consent_revision: "telemetry-v1",
        consented_at: new Date().toISOString(),
        mode: "local",
      },
    };
    ids.push(item.id);
    return item;
  };
  function request(path: string, item: Item, body: unknown, method: string) {
    return new Request(`https://example.invalid${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${item.token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  const register = (item: Item, declaration: unknown = item.declaration) =>
    handle(request(`/v1/installations/${item.id}`, item, declaration, "PUT"));
  const body = (item: Item) => ({
    schema_version: 1,
    tool_id: "dalo",
    installation_id: item.id,
    batch_id: uuid7(),
    consent_revision: "telemetry-v1",
    rows: maxRows(),
  });
  const post = (item: Item, data: unknown) =>
    handle(request("/v1/usage-batches", item, data, "POST"));
  async function expect(response: Response, status: number, error?: string) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 2048);
    const result = JSON.parse(text);
    if (error) assert.deepEqual(result, { schema_version: 1, error: { code: error } });
    checks++;
    return result;
  }
  async function fresh() {
    const item = identity();
    await expect(await register(item), 201);
    return item;
  }
  const counts = (item: Item) =>
    sql(`SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(item.id)}`);
  const clearAttempts = (item: Item) =>
    sql(
      `UPDATE app_tracking.reporting_installations SET upload_attempts='{}' WHERE installation_id=${q(item.id)}`,
    );
  try {
    const a = identity();
    const regs = await Promise.all([register(a), register(a)]);
    assert.deepEqual(regs.map((r) => r.status).sort(), [200, 201]);
    checks++;
    await expect(
      await register({ ...a, token: "f".repeat(64) }, { ...a.declaration, mode: "ci" }),
      401,
      "unauthorized",
    );
    await expect(await register(a, { ...a.declaration, mode: "ci" }), 409, "registration_conflict");
    await expect(
      await register(a, { ...a.declaration, tool_id: "palamedes" }),
      400,
      "unsupported_tool",
    );
    const race = identity();
    const claimed = await Promise.all([
      register(race),
      register({ ...race, token: randomBytes(32).toString("hex") }),
    ]);
    assert.deepEqual(claimed.map((r) => r.status).sort(), [201, 401]);
    checks++;
    phase = "concurrent_batches";
    const data = body(a);
    const copies = process.env.INGESTION_HTTP_DRIVER === "1" ? 8 : 2;
    const same = await Promise.all(
      Array.from({ length: copies }, (_, i) =>
        post(
          a,
          JSON.stringify({ ...data, rows: i % 2 ? [...data.rows].reverse() : data.rows }).padEnd(
            policy.max_batch_bytes,
            " ",
          ),
        ),
      ),
    );
    const acks = await Promise.all(same.map((r) => expect(r, 200)));
    assert.equal(acks.filter((a) => a.status === "accepted").length, 1);
    assert.equal(acks.filter((a) => a.status === "duplicate").length, copies - 1);
    assert.equal(acks[0].payload_sha256, acks[1].payload_sha256);
    assert.equal(acks[0].received_at, acks[1].received_at);
    assert.equal(await counts(a), "256");
    checks += 4;
    await expect(
      await post({ ...a, token: "0".repeat(64) }, { ...data, consent_revision: "telemetry-v2" }),
      401,
      "unauthorized",
    );
    await expect(
      await post(a, { ...data, consent_revision: "telemetry-v2" }),
      409,
      "consent_required",
    );
    await expect(await post(identity(), data), 401, "unauthorized");
    const missing = identity();
    await expect(await post(missing, body(missing)), 404, "installation_not_found");
    await expect(
      await post(a, { ...data, rows: [{ ...data.rows[0], count: 2 }] }),
      409,
      "batch_conflict",
    );
    await clearAttempts(a);
    const conflictId = uuid7();
    const choices = [
      { ...body(a), batch_id: conflictId, rows: [{ ...data.rows[0], count: 2 }] },
      { ...body(a), batch_id: conflictId, rows: [{ ...data.rows[0], count: 3 }] },
    ];
    const conflicts = await Promise.all(choices.map((b) => post(a, b)));
    assert.deepEqual(conflicts.map((r) => r.status).sort(), [200, 409]);
    const winner = conflicts.findIndex((r) => r.status === 200);
    assert.equal(
      await sql(
        `SELECT sum(count) FROM app_tracking.usage_counts WHERE installation_id=${q(a.id)} AND batch_id=${q(conflictId)}`,
      ),
      String(choices[winner].rows[0].count),
    );
    checks += 2;
    phase = "validation_and_rollback";
    const b = await fresh(),
      valid = body(b);
    for (const value of [
      { ...valid, extra: "forbidden" },
      { ...valid, rows: [{ ...valid.rows[0], count: 0 }] },
      { ...valid, rows: [{ ...valid.rows[0], project_id_version: 2 }] },
      { ...valid, rows: [{ ...valid.rows[0], command: "unknown" }] },
      { ...valid, rows: [valid.rows[0], valid.rows[0]] },
      { ...valid, rows: [{ ...valid.rows[0], day: "2026-02-29" }] },
      { ...valid, batch_id: uuid7(Date.now() - 8 * 86400000) },
      { ...valid, batch_id: uuid7(Date.now() + 600000) },
      {
        ...valid,
        rows: [
          {
            ...valid.rows[0],
            day: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
          },
        ],
      },
    ]) {
      assert.equal((await post(b, value)).status, 400);
      checks++;
    }
    assert.equal((await post(b, JSON.stringify(valid).padEnd(65537, " "))).status, 413);
    checks++;
    assert.equal(await counts(b), "0");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.telemetry_batches WHERE installation_id=${q(b.id)}`,
      ),
      "0",
    );
    checks += 2;
    // Force a final INSERT constraint failure beneath the validated HTTP boundary.
    const brokenId = uuid7(),
      tokenHash = await sha256(`app-tracking-token-v1\n${b.id}\n${b.token}`);
    const brokenRows = [valid.rows[0], { ...valid.rows[1], project_id: "invalid" }];
    await assert.rejects(
      psql(
        runtime,
        `SELECT app_tracking.accept_batch_v1('dalo',${q(b.id)},${q(tokenHash)},${q(brokenId)},${q("a".repeat(64))},'telemetry-v1',${q(JSON.stringify(brokenRows))}::jsonb)`,
      ),
    );
    assert.equal(await counts(b), "0");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.telemetry_batches WHERE installation_id=${q(b.id)}`,
      ),
      "0",
    );
    checks += 3;
    phase = "unknown_outcome";
    await clearAttempts(b);
    // The real database commits, then the driver's acknowledgement is lost.
    // The HTTP caller sees 503 and must retry the exact immutable body.
    const lostAck = createTelemetryHandler({
      ...storage,
      async submitV1(...args) {
        await storage.submitV1(...args);
        throw new Error("Synthetic acknowledgement loss");
      },
    });
    await expect(
      await lostAck(request("/v1/usage-batches", b, valid, "POST")),
      503,
      "service_unavailable",
    );
    const retry = await expect(
      await post(b, JSON.stringify(valid).replaceAll('"count":1,', '"count":1.0,')),
      200,
    );
    assert.equal(retry.status, "duplicate");
    assert.equal(await counts(b), "256");
    checks += 2;
    assert.equal(retry.payload_sha256, await sha256(canonicalBatch(validateBatch(valid))));
    checks++;
    phase = "retired_catalog";
    // Retired commands remain canonicalizable for receipts, never new acceptance.
    const replayHash = await sha256(canonicalBatch(validateBatch(valid)));
    const retired = await sql(`BEGIN;
      UPDATE app_tracking.command_catalog_v1 SET accept_new=false WHERE command='status';
      SELECT app_tracking.accept_batch_v1('dalo',${q(b.id)},${q(tokenHash)},${q(valid.batch_id)},${q(replayHash)},'telemetry-v1',${q(JSON.stringify(valid.rows))}::jsonb);
      SELECT app_tracking.accept_batch_v1('dalo',${q(b.id)},${q(tokenHash)},${q(uuid7())},${q(replayHash)},'telemetry-v1',${q(JSON.stringify(valid.rows))}::jsonb);
      ROLLBACK;`);
    const retiredResults = retired.split("\n").map((line) => JSON.parse(line));
    assert.equal(retiredResults[0].status, "duplicate");
    assert.deepEqual(retiredResults[1], { error: "invalid_request" });
    checks += 2;
    phase = "quotas";
    const quota = await fresh();
    const full = {
      ...body(quota),
      rows: maxRows()
        .slice(0, 10)
        .map((r) => ({ ...r, count: 1000000 })),
    };
    await expect(await post(quota, full), 200);
    await expect(await post(quota, full), 200);
    await expect(await post(quota, { ...body(quota), rows: [maxRows()[0]] }), 400, "count_limit");
    assert.equal(await counts(quota), "10");
    checks++;
    const total = await fresh();
    await expect(
      await post(total, {
        ...body(total),
        rows: maxRows()
          .slice(0, 11)
          .map((r) => ({ ...r, count: 1000000 })),
      }),
      400,
      "count_limit",
    );
    assert.equal(await counts(total), "0");
    checks++;
    phase = "rate_limit";
    const rate = await fresh(),
      limited = body(rate);
    for (let i = 0; i < 10; i++) await expect(await post(rate, limited), 200);
    const last = await post(rate, limited);
    await expect(last, 429, "rate_limited");
    assert.equal(last.headers.get("retry-after"), "60");
    assert.equal(await counts(rate), "256");
    checks++;
    await sql(
      `UPDATE app_tracking.reporting_installations SET upload_attempts=ARRAY[clock_timestamp()-interval '61 seconds'] WHERE installation_id=${q(rate.id)}`,
    );
    await expect(await post(rate, limited), 200);
    phase = "lifecycle";
    const old = identity();
    old.id = uuid7(Date.now() - 600000);
    ids.push(old.id);
    await expect(await register(old), 410, "installation_expired");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.reporting_installations WHERE installation_id=${q(old.id)}`,
      ),
      "0",
    );
    checks++;
    await sql(
      `UPDATE app_tracking.reporting_installations SET last_activity_at=clock_timestamp()-interval '90 days' WHERE installation_id=${q(b.id)}`,
    );
    await expect(await post(b, valid), 410, "installation_expired");
    await expect(await register(b), 410, "installation_expired");
    await psql(
      runtime,
      `SELECT app_tracking.revoke_installation('dalo',${q(a.id)},${q(await sha256(`app-tracking-token-v1\n${a.id}\n${a.token}`))})`,
    );
    await expect(await post(a, data), 410, "installation_revoked");
    await expect(await register(a), 410, "installation_revoked");
    await expect(await post({ ...a, token: "0".repeat(64) }, data), 401, "unauthorized");
    assert.equal(await counts(a), "0");
    checks++;
    const catalog = JSON.parse(
      await sql(
        "SELECT json_agg(command ORDER BY command) FROM app_tracking.command_catalog_v1 WHERE accept_new",
      ),
    );
    assert.deepEqual(catalog, [...policy.tools.dalo.commands].sort());
    checks++;
    return {
      checks,
      transport: process.env.INGESTION_HTTP_DRIVER === "1" ? "PlanetScale HTTP" : "PostgreSQL TCP",
      concurrency: "passed",
      public_routes_enabled: false,
    };
  } catch {
    console.error(JSON.stringify({ ingestion_test_phase: phase, completed_checks: checks }));
    throw new Error("Ingestion integration failed; inspect privately");
  } finally {
    for (const id of ids)
      await sql(
        `DELETE FROM app_tracking.reporting_installations WHERE installation_id=${q(id)} AND tool_id='dalo'`,
      );
  }
}
