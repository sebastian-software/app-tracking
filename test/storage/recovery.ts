import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { grantRuntime } from "../../scripts/storage/grant-runtime.ts";
import { runMaintenance } from "../../scripts/storage/maintenance.ts";
import { createTelemetryHandler } from "../../src/telemetry/handler.ts";
import { sha256 } from "../../src/telemetry/contract.ts";
import { integrationStorage } from "./adapter.ts";
import { uuid7, maxRows } from "./fixture.ts";

// Only a disposable local container. Never export a provider database or restore
// into the source database. Snapshot bytes stay in memory, outside logs/artifacts.
export async function recoveryIntegration(admin: string, runtime: string) {
  const container = process.env.RESTORE_TEST_CONTAINER;
  if (!container) return { status: "skipped", reason: "isolated local container required" };
  const parsed = new URL(admin);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/app_tracking" ||
    process.env.INGESTION_HTTP_DRIVER === "1"
  )
    throw new Error("Disposable local recovery target required");
  const restored = new URL(admin);
  restored.pathname = "/app_tracking_restore";
  const restoredRuntime = new URL(runtime);
  restoredRuntime.pathname = "/app_tracking_restore";
  const ids = [uuid7(), uuid7(Date.now() - 92 * 86400000)];
  const token = randomBytes(32).toString("hex"),
    handle = createTelemetryHandler(integrationStorage(runtime));
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://example.invalid${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  function docker(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "docker",
        ["exec", ...(input === undefined ? [] : ["-i"]), container!, ...args],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(new Error("Isolated recovery command failed"));
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  let checks = 0,
    phase = "snapshot";
  try {
    const registration = {
      schema_version: 1,
      tool_id: "dalo",
      consent_revision: "telemetry-v1",
      consented_at: new Date().toISOString(),
      mode: "local",
    };
    assert.equal(
      (await handle(request("PUT", `/v1/installations/${ids[0]}`, registration))).status,
      201,
    );
    const batch = {
      schema_version: 1,
      tool_id: "dalo",
      installation_id: ids[0],
      batch_id: uuid7(),
      consent_revision: "telemetry-v1",
      rows: [maxRows()[0]],
    };
    assert.equal((await handle(request("POST", "/v1/usage-batches", batch))).status, 200);
    checks += 2;
    await psql(
      admin,
      `INSERT INTO app_tracking.reporting_installations(tool_id,installation_id,token_hash,consent_revision,consented_at,mode,last_activity_at)
      VALUES('dalo',${q(ids[1])},${q(await sha256(`app-tracking-token-v1\n${ids[1]}\n${token}`))},'telemetry-v1',clock_timestamp()-interval '92 days','local',clock_timestamp());
      INSERT INTO app_tracking.telemetry_batches VALUES('dalo',${q(ids[1])},${q(uuid7(Date.now() - 89 * 86400000))},repeat('a',64),clock_timestamp()-interval '89 days');
      INSERT INTO app_tracking.usage_counts SELECT tool_id,installation_id,batch_id,1,current_date-90,'1.0.0','status',1,NULL,NULL
        FROM app_tracking.telemetry_batches WHERE installation_id=${q(ids[1])};`,
    );
    const dump = await docker([
      "pg_dump",
      "-U",
      "app_tracking_migrator",
      "-d",
      "app_tracking",
      "--no-owner",
      "--no-privileges",
    ]);
    assert.equal((await handle(request("DELETE", `/v1/installations/${ids[0]}`))).status, 204);
    checks++;
    phase = "restore";
    await psql(
      restored.href,
      "SET ROLE app_tracking_owner; DROP SCHEMA IF EXISTS app_tracking CASCADE; DROP TABLE IF EXISTS public.app_tracking_migrations;",
    );
    await docker(
      [
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "app_tracking_migrator",
        "-d",
        "app_tracking_restore",
      ],
      "SET ROLE app_tracking_owner;\n" + dump,
    );
    // --no-privileges omits the original REVOKEs too. Restore the private
    // function boundary before granting the narrowly scoped runtime login.
    await psql(
      restored.href,
      "SET ROLE app_tracking_owner; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_tracking FROM PUBLIC;",
    );
    await grantRuntime(restored.href, await psql(runtime, "SELECT current_user"));
    assert.equal(
      await psql(
        admin,
        `SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(ids[0])}`,
      ),
      "0",
    );
    assert.equal(
      await psql(
        restored.href,
        `SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(ids[0])}`,
      ),
      "1",
    );
    assert.equal(
      await psql(
        restored.href,
        `SELECT count(*) FROM app_tracking.reporting_usage_v1 WHERE installation_id=${q(ids[1])}`,
      ),
      "0",
    );
    checks += 3;
    // Restoring a pre-deletion point rolls that deletion back. Retry the original
    // batch against its restored receipt; do not append the snapshot's counts.
    const restoredHandle = createTelemetryHandler(integrationStorage(restoredRuntime.href));
    const replay = await restoredHandle(request("POST", "/v1/usage-batches", batch));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).status, "duplicate");
    assert.equal(
      await psql(
        restored.href,
        `SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${q(ids[0])}`,
      ),
      "1",
    );
    checks += 3;
    assert.equal(
      (await restoredHandle(request("DELETE", `/v1/installations/${ids[0]}`))).status,
      204,
    );
    checks++;
    await runMaintenance(restored.href, 100, 1000);
    assert.equal(
      await psql(
        restored.href,
        `SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id IN (${ids.map(q).join(",")})`,
      ),
      "0",
    );
    checks++;
    return {
      status: "passed",
      checks,
      scope: "isolated PostgreSQL snapshot; not a PlanetScale restore",
      later_deletion_rollback: "demonstrated",
      snapshot_counts_appended: false,
    };
  } catch {
    console.error(JSON.stringify({ recovery_test_phase: phase, completed_checks: checks }));
    throw new Error("Recovery proof failed; inspect privately");
  } finally {
    for (const url of [admin, restored.href])
      await psql(
        url,
        `DELETE FROM app_tracking.reporting_installations WHERE installation_id IN (${ids.map(q).join(",")})`,
      );
  }
}
