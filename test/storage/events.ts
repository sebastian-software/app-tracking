import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import {
  createEventHandler,
  type EventBatch,
  type EventStorage,
} from "../../src/telemetry/events.ts";
import { canonical } from "../../src/telemetry/contract.ts";
import { hash } from "./fixture.ts";

export async function eventIntegration(admin: string, runtime: string) {
  const run = (sql: string) => psql(runtime, sql);
  const owner = process.env.MIGRATION_OWNER_ROLE ?? "postgres";
  const sql = (text: string) => psql(admin, `SET ROLE "${owner}"; ${text}`);
  const hex = () => randomBytes(32).toString("hex");
  const id = hex(),
    token = hex(),
    batchId = hex();
  const identities = new Set([id]);
  const value: EventBatch = {
    schema_version: 1,
    tool_id: "ferriki",
    batch_id: batchId,
    collection: "opt_in",
    mode: "local",
    installation_id: id,
    consented_at: Date.now(),
    rows: [
      {
        day: Math.floor(Date.now() / 86400000),
        metric: "resource.download",
        collection: "opt_in",
        tool_version: "2.0.0",
        dimensions: { kind: "grammar" },
        count: 3,
        project_id: "e".repeat(64),
        project_id_version: 1,
        system: { os: "macos", os_version: "26.1", arch: "aarch64", cpu_family: "apple_m4" },
      },
    ],
  };
  const statement = (b: EventBatch, contentHash: string, tokenHash: string | null) =>
    `SELECT app_tracking.accept_events_v1(${q(b.tool_id)},${q(b.collection)},${b.installation_id ? q(b.installation_id) : "NULL"},${tokenHash ? q(tokenHash) : "NULL"},${b.consented_at ?? "NULL"},${q(b.mode)},${q(b.batch_id)},${q(contentHash)},${q(JSON.stringify(b.rows))}::jsonb)`;
  const storage: EventStorage = {
    async submitEvents(b, contentHash, tokenHash) {
      if (b.installation_id) identities.add(b.installation_id);
      return { result: JSON.parse(await run(statement(b, contentHash, tokenHash))) };
    },
    async deleteEvents(tool, installation, tokenHash) {
      return {
        result: JSON.parse(
          await run(
            `SELECT app_tracking.delete_events_v1(${q(tool)},${q(installation)},${q(tokenHash)})`,
          ),
        ),
      };
    },
  };
  const handle = createEventHandler(storage);
  const request = (b: EventBatch) =>
    new Request("https://fixture.example/v1/event-batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(b),
    });
  let checks = 0;
  try {
    // A synthetic opt-out definition proves the route without enabling a new
    // production baseline metric as a side effect of this implementation.
    const fixtureDefinitions = { basic: { collection: "opt_out", dimensions: {}, system: "none" } };
    await sql(
      `INSERT INTO app_tracking.event_catalog_v1 VALUES('test-events',${q(JSON.stringify(fixtureDefinitions))}::jsonb)`,
    );
    const baselineValue: EventBatch = {
      schema_version: 1,
      tool_id: "test-events",
      batch_id: hex(),
      collection: "opt_out",
      mode: "local",
      rows: [
        {
          day: Math.floor(Date.now() / 86400000),
          metric: "basic",
          collection: "opt_out",
          tool_version: "1.0.0",
          dimensions: {},
          count: 2,
        },
      ],
    };
    const basicHandler = createEventHandler(storage, { "test-events": fixtureDefinitions });
    const basicRequest = () =>
      new Request("https://fixture.example/v1/event-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baselineValue),
      });
    assert.equal((await basicHandler(basicRequest())).status, 200);
    assert.equal((await basicHandler(basicRequest())).status, 200);
    assert.equal(
      await sql("SELECT sum(count) FROM app_tracking.event_counts_v1 WHERE tool_id='test-events'"),
      "2",
    );
    assert.equal(
      await sql(
        "SELECT count(*) FROM app_tracking.event_installations_v1 WHERE tool_id='test-events'",
      ),
      "0",
    );
    checks += 4;
    const catalog = JSON.parse(await readFile("contracts/event-catalog.json", "utf8"));
    for (const [tool, metrics] of Object.entries(catalog.tools)) {
      assert.deepEqual(
        JSON.parse(
          await sql(`SELECT metrics FROM app_tracking.event_catalog_v1 WHERE tool_id=${q(tool)}`),
        ),
        metrics,
      );
      checks++;
    }
    const replies = await Promise.all([handle(request(value)), handle(request(value))]);
    assert.deepEqual(
      replies.map((r) => r.status),
      [200, 200],
    );
    assert.equal(
      await sql(`SELECT sum(count) FROM app_tracking.event_counts_v1 WHERE batch_id=${q(batchId)}`),
      "3",
    );
    checks += 2;
    assert.equal(
      (await handle(request({ ...value, rows: [{ ...value.rows[0], count: 4 }] }))).status,
      409,
    );
    checks++;
    const wrongToken = await storage.submitEvents(
      value,
      hash(canonical(value)),
      hash("wrong"),
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(wrongToken.result, { error: "unauthorized" });
    checks++;
    // Direct runtime calls cannot bypass HTTP's trusted metric route validation.
    const changed = {
      ...value,
      batch_id: hex(),
      rows: [{ ...value.rows[0], dimensions: { kind: "private-path" } }],
    };
    assert.deepEqual(
      (
        await storage.submitEvents(
          changed,
          hash(canonical(changed)),
          hash(token),
          AbortSignal.timeout(3000),
        )
      ).result,
      { error: "invalid_request" },
    );
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.event_batches_v1 WHERE batch_id=${q(changed.batch_id)}`,
      ),
      "0",
    );
    checks += 2;
    const baseline = {
      ...value,
      collection: "opt_out" as const,
      batch_id: hex(),
      installation_id: undefined,
      consented_at: undefined,
      rows: [{ ...value.rows[0], collection: "opt_out" }],
    };
    assert.deepEqual(
      (
        await storage.submitEvents(
          baseline,
          hash(canonical(baseline)),
          null,
          AbortSignal.timeout(3000),
        )
      ).result,
      { error: "invalid_request" },
    );
    checks++;
    // Active profiles keep their grant; only new stale grants and inactive
    // profiles expire. Failed registration must not leave an identity behind.
    const oldGrant = Date.now() - 91 * 86400000;
    const stale = { ...value, installation_id: hex(), consented_at: oldGrant, batch_id: hex() };
    assert.deepEqual(
      (
        await storage.submitEvents(
          stale,
          hash(canonical(stale)),
          hash(token),
          AbortSignal.timeout(3000),
        )
      ).result,
      { error: "consent_required" },
    );
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.event_installations_v1 WHERE installation_id=${q(stale.installation_id)}`,
      ),
      "0",
    );
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET consented_at=${oldGrant} WHERE installation_id=${q(id)}`,
    );
    const active = { ...value, consented_at: oldGrant, batch_id: hex() };
    assert.equal((await handle(request(active))).status, 200);
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET last_activity_at=clock_timestamp()-interval '91 days' WHERE installation_id=${q(id)}`,
    );
    assert.equal((await handle(request({ ...active, batch_id: hex() }))).status, 410);
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET last_activity_at=clock_timestamp() WHERE installation_id=${q(id)}`,
    );
    checks += 4;
    const deletion = new Request(`https://fixture.example/v1/event-installations/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "App-Tracking-Tool": "ferriki" },
    });
    assert.equal((await handle(deletion)).status, 204);
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.reporting_events_v1 WHERE installation_id=${q(id)}`,
      ),
      "0",
    );
    assert.equal((await handle(request(value))).status, 410);
    checks += 3;
    // A real Rust executable downloads over HTTP and its short-lived worker
    // sends a batch through this handler into the unprivileged SQL boundary.
    const directory = await mkdtemp(join(tmpdir(), "app-tracking-events-"));
    const server = createServer(async (req, res) => {
      if (req.url === "/fixture-resource") {
        assert.equal(req.headers.authorization, undefined);
        res.end("synthetic grammar");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "DELETE" ? undefined : Buffer.concat(chunks),
      });
      const output = await handle(input);
      res.writeHead(output.status, Object.fromEntries(output.headers));
      res.end(Buffer.from(await output.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const executable =
      join(process.cwd(), "target/debug/examples/unified-client-fixture") +
      (process.platform === "win32" ? ".exe" : "");
    const invoke = (operation: string) =>
      promisify(execFile)(executable, [operation], {
        env: {
          ...process.env,
          APP_TRACKING_FIXTURE_ORIGIN: origin,
          APP_TRACKING_FIXTURE_ROOT: directory,
        },
        timeout: 3000,
      });
    try {
      await invoke("enable");
      await invoke("download");
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        if (
          Number(
            await sql("SELECT count(*) FROM app_tracking.event_counts_v1 WHERE tool_id='ferriki'"),
          ) > 0
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        await sql(
          "SELECT sum(count) FROM app_tracking.event_counts_v1 WHERE tool_id='ferriki' AND metric='resource.download'",
        ),
        "1",
      );
      checks++;
      await invoke("record");
      const preview = JSON.parse((await invoke("preview")).stdout);
      assert.equal(preview.open[0].metric, "language.use");
      checks++;
      await invoke("baseline");
      assert.deepEqual(JSON.parse((await invoke("preview")).stdout).open, []);
      checks++;
      await invoke("delete");
      const deletionUntil = Date.now() + 10000;
      while (Date.now() < deletionUntil) {
        if (
          (await sql(
            "SELECT count(*) FROM app_tracking.event_installations_v1 WHERE tool_id='ferriki' AND active",
          )) === "0"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        await sql(
          "SELECT count(*) FROM app_tracking.event_installations_v1 WHERE tool_id='ferriki' AND active",
        ),
        "0",
      );
      checks++;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
    return { checks, status: "passed" };
  } finally {
    await sql(
      "DELETE FROM app_tracking.event_batches_v1 WHERE tool_id='test-events'; DELETE FROM app_tracking.event_quotas_v1 WHERE tool_id='test-events'; DELETE FROM app_tracking.event_catalog_v1 WHERE tool_id='test-events';",
    );
    for (const identity of identities)
      await sql(`DELETE FROM app_tracking.event_batches_v1 WHERE tool_id='ferriki' AND installation_id=${q(identity)};
      DELETE FROM app_tracking.event_installations_v1 WHERE tool_id='ferriki' AND installation_id=${q(identity)};
      DELETE FROM app_tracking.event_quotas_v1 WHERE tool_id='ferriki' AND principal=${q(identity)};`);
  }
}
