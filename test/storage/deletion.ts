import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { runMaintenance } from "../../scripts/storage/maintenance.ts";
import { createTelemetryHandler } from "../../src/telemetry/handler.ts";
import { canonicalBatch, batch as validateBatch, sha256 } from "../../src/telemetry/contract.ts";
import { uuid7, maxRows } from "./fixture.ts";
import { withUsageLock } from "./lock.ts";
import { integrationStorage } from "./adapter.ts";

export async function deletionIntegration(admin: string, runtime: string) {
  const sql = (text: string) => psql(admin, text),
    storage = integrationStorage(runtime),
    handle = createTelemetryHandler(storage);
  const ids: string[] = [];
  let checks = 0,
    phase = "deletion",
    measuredCalls = 0,
    lastStatus = 0;
  const identity = () => {
    const item = {
      id: uuid7(),
      token: randomBytes(32).toString("hex"),
      consentedAt: new Date().toISOString(),
    };
    ids.push(item.id);
    return item;
  };
  type Item = ReturnType<typeof identity>;
  const declaration = (item: Item) => ({
    schema_version: 1,
    tool_id: "dalo",
    consent_revision: "telemetry-v1",
    consented_at: item.consentedAt,
    mode: "local",
  });
  const request = (item: Item, path: string, method: string, body?: unknown) =>
    new Request(`https://example.invalid${path}`, {
      method,
      headers: {
        authorization: `Bearer ${item.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const reg = (item: Item) =>
    handle(request(item, `/v1/installations/${item.id}`, "PUT", declaration(item)));
  const del = (item: Item) => handle(request(item, `/v1/installations/${item.id}`, "DELETE"));
  const body = (item: Item) => ({
    schema_version: 1,
    tool_id: "dalo",
    installation_id: item.id,
    batch_id: uuid7(),
    consent_revision: "telemetry-v1",
    rows: [maxRows()[0]],
  });
  const post = (item: Item, data = body(item)) =>
    handle(request(item, "/v1/usage-batches", "POST", data));
  const count = (table: string, item: Item) =>
    sql(`SELECT count(*) FROM app_tracking.${table} WHERE installation_id=${q(item.id)}`);
  async function expect(response: Response, status: number, error?: string) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (status === 204) {
      assert.equal(await response.text(), "");
      assert.equal(response.headers.has("content-type"), false);
    } else if (error)
      assert.deepEqual(await response.json(), { schema_version: 1, error: { code: error } });
    checks++;
  }
  async function fresh() {
    const item = identity();
    await expect(await reg(item), 201);
    return item;
  }
  async function seed(item: Item, rows: number, rowsPerBatch = 256) {
    const batchIds = Array.from({ length: Math.ceil(rows / rowsPerBatch) }, () => uuid7());
    await sql(`INSERT INTO app_tracking.telemetry_batches
      SELECT 'dalo',${q(item.id)},b::uuid,repeat('a',64),clock_timestamp()
      FROM jsonb_array_elements_text(${q(JSON.stringify(batchIds))}::jsonb) b;
      ANALYZE app_tracking.telemetry_batches;
      INSERT INTO app_tracking.usage_counts
      SELECT 'dalo',${q(item.id)},b::uuid,n::smallint,current_date,'1.0.0','status',1,repeat('a',64),1
      FROM jsonb_array_elements_text(${q(JSON.stringify(batchIds))}::jsonb) WITH ORDINALITY x(b,ord)
      CROSS JOIN generate_series(1,${rowsPerBatch}) n WHERE (ord-1)*${rowsPerBatch}+n<=${rows};
      INSERT INTO app_tracking.daily_quotas VALUES('dalo',${q(item.id)},current_date,${rows});
      ANALYZE app_tracking.usage_counts;`);
  }
  try {
    const a = await fresh(),
      b = await fresh();
    await expect(await post(a), 200);
    await expect(await post(b), 200);
    await expect(await del({ ...a, token: "0".repeat(64) }), 401, "unauthorized");
    const missing = identity();
    await expect(await del(missing), 404, "installation_not_found");
    await expect(
      await handle(request(a, `/v1/installations/${a.id}`, "DELETE", null)),
      400,
      "invalid_request",
    );
    assert.equal(await count("usage_counts", a), "1");
    checks++;
    await sql(
      `UPDATE app_tracking.reporting_installations SET upload_attempts=array_fill(clock_timestamp(),ARRAY[10]) WHERE installation_id=${q(a.id)}`,
    );
    await expect(await del(a), 204);
    for (const table of ["usage_counts", "telemetry_batches", "daily_quotas"]) {
      assert.equal(await count(table, a), "0");
      checks++;
    }
    assert.equal(await count("usage_counts", b), "1");
    checks++;
    const transitioned = await sql(
      `SELECT transitioned_at FROM app_tracking.reporting_installations WHERE installation_id=${q(a.id)}`,
    );
    await expect(await del(a), 204);
    assert.equal(
      await sql(
        `SELECT transitioned_at FROM app_tracking.reporting_installations WHERE installation_id=${q(a.id)}`,
      ),
      transitioned,
    );
    checks++;
    assert.equal(
      await sql(
        `SELECT consent_revision IS NULL AND consented_at IS NULL AND mode IS NULL AND last_activity_at IS NULL AND upload_attempts='{}' AND NOT purge_pending FROM app_tracking.reporting_installations WHERE installation_id=${q(a.id)}`,
      ),
      "t",
    );
    checks++;
    await expect(await post(a), 410, "installation_revoked");
    await expect(await reg(a), 410, "installation_revoked");
    phase = "races";
    const race = await fresh();
    const races = await Promise.all([post(race), del(race)]);
    assert.ok([200, 410].includes(races[0].status));
    await expect(races[1], 204);
    assert.equal(await count("usage_counts", race), "0");
    checks += 2;
    const raceReg = await fresh();
    const registrationRace = await Promise.all([reg(raceReg), del(raceReg)]);
    assert.ok([200, 410].includes(registrationRace[0].status));
    await expect(registrationRace[1], 204);
    await expect(await reg(raceReg), 410, "installation_revoked");
    checks++;
    const lost = await fresh();
    await expect(await post(lost), 200);
    const lostAck = createTelemetryHandler({
      ...storage,
      async deleteV1(...args) {
        await storage.deleteV1(...args);
        throw new Error("Synthetic lost acknowledgement");
      },
    });
    await expect(
      await lostAck(request(lost, `/v1/installations/${lost.id}`, "DELETE")),
      503,
      "service_unavailable",
    );
    await expect(await del(lost), 204);
    phase = "blocked_purge";
    const blocked = await fresh();
    await expect(await post(blocked), 200);
    await withUsageLock(admin, blocked.id, async () => {
      await expect(await del(blocked), 503, "service_unavailable");
      assert.equal(await count("usage_counts", blocked), "1");
      assert.equal(await count("reporting_usage_v1", blocked), "0");
      checks += 2;
      await expect(await post(blocked), 410, "installation_revoked");
    });
    await expect(await del(blocked), 204);
    phase = "bounded_progress";
    const large = await fresh();
    await seed(large, 2500);
    await expect(await del(large), 503, "service_unavailable");
    assert.equal(await count("usage_counts", large), "1500");
    assert.equal(await count("reporting_usage_v1", large), "0");
    checks += 2;
    await expect(await post(large), 410, "installation_revoked");
    await assert.rejects(runMaintenance(admin, 1, 1000));
    checks++;
    assert.equal(await count("usage_counts", large), "500");
    checks++;
    assert.equal((await runMaintenance(admin, 100, 1000)).complete, true);
    await expect(await del(large), 204);
    checks++;
    phase = "volume_seed";
    const volume = await fresh();
    await seed(volume, 32768, 1);
    phase = "page_budget_measurement";
    const latencies: number[] = [];
    let calls = 0;
    while (true) {
      const started = performance.now(),
        response = await del(volume);
      latencies.push(performance.now() - started);
      calls++;
      measuredCalls = calls;
      lastStatus = response.status;
      assert.ok([204, 503].includes(response.status));
      if (response.status === 204) break;
      assert.ok(calls < 40);
    }
    assert.equal(calls, 33);
    assert.equal(await count("usage_counts", volume), "0");
    checks += 2;
    phase = "retention";
    const historical = identity();
    historical.id = uuid7(Date.now() - 92 * 86400000);
    ids.push(historical.id);
    const tokenHash = await sha256(`app-tracking-token-v1\n${historical.id}\n${historical.token}`);
    await sql(`INSERT INTO app_tracking.reporting_installations(tool_id,installation_id,token_hash,consent_revision,consented_at,mode,last_activity_at)
      VALUES('dalo',${q(historical.id)},${q(tokenHash)},'telemetry-v1',clock_timestamp()-interval '92 days','local',clock_timestamp());`);
    const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const retained = {
      ...body(historical),
      batch_id: uuid7(Date.now() - 89 * 86400000),
      rows: [
        { ...maxRows()[0], day: day(90) },
        { ...maxRows()[0], day: day(89) },
      ],
    };
    const expired = {
      ...body(historical),
      batch_id: uuid7(Date.now() - 91 * 86400000),
      rows: [{ ...maxRows()[0], day: day(91) }],
    };
    for (const [batch, age] of [
      [retained, 89],
      [expired, 91],
    ] as const) {
      await sql(`INSERT INTO app_tracking.telemetry_batches VALUES('dalo',${q(historical.id)},${q(batch.batch_id)},${q(await sha256(canonicalBatch(validateBatch(batch))))},clock_timestamp()-interval '${age} days');
        INSERT INTO app_tracking.usage_counts SELECT 'dalo',${q(historical.id)},${q(batch.batch_id)},n::smallint,(r->>'day')::date,'1.0.0','status',1,r->>'project_id',1
        FROM jsonb_array_elements(${q(JSON.stringify(batch.rows))}::jsonb) WITH ORDINALITY AS x(r,n);`);
    }
    assert.equal(await count("reporting_usage_v1", historical), "1");
    checks++;
    await sql(`UPDATE app_tracking.reporting_installations SET upload_attempts=ARRAY[clock_timestamp()-interval '61 seconds'] WHERE installation_id=${q(b.id)};
      INSERT INTO app_tracking.daily_quotas VALUES('dalo',${q(historical.id)},current_date-8,1);`);
    const result = await runMaintenance(admin, 100, 1);
    assert.equal(result.complete, true);
    checks++;
    assert.equal(await count("usage_counts", historical), "1");
    assert.equal(await count("telemetry_batches", historical), "1");
    assert.equal(await count("daily_quotas", historical), "0");
    checks += 3;
    await expect(await post(historical, retained), 200);
    await expect(
      await post(historical, { ...expired, rows: [maxRows()[0]] }),
      400,
      "batch_expired",
    );
    const inactive = await fresh();
    await expect(await post(inactive), 200);
    await sql(
      `UPDATE app_tracking.reporting_installations SET last_activity_at=clock_timestamp()-interval '90 days' WHERE installation_id=${q(inactive.id)}`,
    );
    assert.equal(await count("reporting_usage_v1", inactive), "0");
    checks++;
    await expect(await post(inactive), 410, "installation_expired");
    await runMaintenance(admin, 100, 1000);
    assert.equal(await count("usage_counts", inactive), "0");
    assert.equal(
      await sql(
        `SELECT state='expired' AND NOT purge_pending FROM app_tracking.reporting_installations WHERE installation_id=${q(inactive.id)}`,
      ),
      "t",
    );
    checks += 2;
    const tombstone = identity();
    tombstone.id = uuid7(Date.now() - 181 * 86400000);
    ids.push(tombstone.id);
    await sql(`INSERT INTO app_tracking.reporting_installations(tool_id,installation_id,token_hash,state,transitioned_at)
      VALUES('dalo',${q(tombstone.id)},${q(await sha256(`app-tracking-token-v1\n${tombstone.id}\n${tombstone.token}`))},'revoked',clock_timestamp()-interval '90 days')`);
    await runMaintenance(admin, 100, 1000);
    await expect(await del(tombstone), 404, "installation_not_found");
    await expect(await reg(tombstone), 410, "installation_expired");
    assert.equal(
      await sql(
        `SELECT cardinality(upload_attempts) FROM app_tracking.reporting_installations WHERE installation_id=${q(b.id)}`,
      ),
      "0",
    );
    checks++;
    phase = "permissions";
    for (const forbidden of [
      "SELECT app_tracking.maintain_v1(1)",
      `SELECT app_tracking.purge_step_v1('dalo',${q(b.id)},1)`,
      "SELECT * FROM app_tracking.reporting_usage_v1",
      "SELECT * FROM app_tracking.maintenance_state",
    ]) {
      await assert.rejects(psql(runtime, forbidden));
      checks++;
    }
    assert.equal(
      await sql("SELECT last_completed_at IS NOT NULL FROM app_tracking.maintenance_state"),
      "t",
    );
    checks++;
    return {
      checks,
      fixture_rows: 32768,
      fixture_receipts: 32768,
      deletion_calls: calls,
      max_client_page_ms: Math.max(...latencies),
      transport: process.env.INGESTION_HTTP_DRIVER === "1" ? "PlanetScale HTTP" : "PostgreSQL TCP",
      public_routes_enabled: false,
    };
  } catch (error) {
    const state =
      error instanceof Error
        ? error.message.match(/Database operation failed \(([0-9A-Z]{5})\)/)?.[1]
        : undefined;
    console.error(
      JSON.stringify({
        deletion_test_phase: phase,
        completed_checks: checks,
        measured_calls: measuredCalls,
        last_status: lastStatus,
        sqlstate: state,
      }),
    );
    throw new Error("Deletion integration failed; inspect privately");
  } finally {
    for (const id of ids)
      await sql(
        `DELETE FROM app_tracking.reporting_installations WHERE tool_id='dalo' AND installation_id=${q(id)}`,
      );
  }
}
