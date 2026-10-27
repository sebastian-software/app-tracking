import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanupEventProbe, saveEventProbe, EVENT_PROBE_BASE } from "./verify-events.ts";
import { psql, quote } from "./storage/psql.ts";

const execute = promisify(execFile);
let stage = "configuration";
interface ProbeState {
  identity: { id: string; token: string; last_accepted_at: number } | null;
  open: Record<string, unknown>;
  batches: unknown[];
  next_attempt: number;
  deleting: boolean;
}
try {
  const version = process.env.APP_TRACKING_CLIENT_VERSION ?? "";
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const database = process.env.MIGRATION_DATABASE_URL;
  const owner = process.env.MIGRATION_OWNER_ROLE;
  assert.ok(database && owner && /^[a-z][a-z0-9_]{0,62}$/.test(owner));
  const msrv = /^rust-version = "([0-9.]+)"$/m.exec(await readFile("Cargo.toml", "utf8"))?.[1];
  assert.ok(msrv);
  const childEnv = { ...process.env };
  delete childEnv.MIGRATION_DATABASE_URL;
  delete childEnv.MIGRATION_OWNER_ROLE;
  await cleanupEventProbe();
  const directory = await mkdtemp(join(tmpdir(), "app-tracking-published-events-"));
  let cleaned = false;
  try {
    stage = "published-package";
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, "Cargo.toml"),
      `[package]\nname = "published-event-consumer"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n[dependencies]\napp-tracking = "=${version}"\n`,
    );
    await writeFile(
      join(directory, "src/main.rs"),
      await readFile("crates/app-tracking/examples/unified-client-fixture.rs", "utf8"),
    );
    const cargo = async (args: string[]) =>
      execute("cargo", [`+${msrv}`, ...args, "--manifest-path", join(directory, "Cargo.toml")], {
        timeout: 240_000,
        env: childEnv,
        maxBuffer: 1024 * 1024,
      });
    await cargo(["build"]);
    const metadata = JSON.parse((await cargo(["metadata", "--format-version", "1"])).stdout);
    const dependency = metadata.packages.find((p: { name: string }) => p.name === "app-tracking");
    assert.ok(dependency?.version === version && dependency.source?.startsWith("registry+"));
    const executable = join(directory, "target/debug/published-event-consumer");
    const stateRoot = join(directory, "profile");
    const statePath = join(
      stateRoot,
      createHash("sha256").update(EVENT_PROBE_BASE).digest("hex"),
      "ferriki/events-v1/ci/state.json",
    );
    const env: NodeJS.ProcessEnv = {
      ...childEnv,
      APP_TRACKING_FIXTURE_ORIGIN: EVENT_PROBE_BASE,
      APP_TRACKING_FIXTURE_ROOT: stateRoot,
      APP_TRACKING_FIXTURE_CI: "1",
    };
    // The child only needs its synthetic profile; do not inherit database authority.
    delete env.MIGRATION_DATABASE_URL;
    delete env.MIGRATION_OWNER_ROLE;
    const invoke = (operation: string) =>
      execute(executable, [operation], { env, timeout: 15_000, maxBuffer: 8192 });
    const state = async (): Promise<ProbeState> => JSON.parse(await readFile(statePath, "utf8"));
    stage = "permission-boundary";
    assert.equal((await invoke("permission")).stdout.trim(), "Unavailable");
    await assert.rejects(access(statePath));
    await invoke("baseline");
    await invoke("record");
    const declined = await state();
    assert.ok(
      declined.identity === null &&
        Object.keys(declined.open).length === 0 &&
        declined.batches.length === 0,
    );
    await invoke("enable");
    const identity = (await state()).identity;
    assert.ok(
      identity && /^[0-9a-f]{64}$/.test(identity.id) && /^[0-9a-f]{64}$/.test(identity.token),
    );
    await saveEventProbe({
      id: identity.id,
      token: identity.token,
      tool: "ferriki",
      base: EVENT_PROBE_BASE,
    });
    stage = "verified-resource";
    const response = await fetch(new URL("/health", EVENT_PROBE_BASE), {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const resource = await response.text();
    assert.equal(resource, JSON.stringify({ status: "ok" }));
    env.APP_TRACKING_FIXTURE_RESOURCE_URL = `${EVENT_PROBE_BASE}/health`;
    env.APP_TRACKING_FIXTURE_RESOURCE_BYTES = String(Buffer.byteLength(resource));
    env.APP_TRACKING_FIXTURE_RESOURCE_SHA256 = createHash("sha256").update(resource).digest("hex");
    await invoke("exercise");
    const wait = async (predicate: (value: ProbeState) => boolean) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        try {
          const snapshot = await state();
          if (predicate(snapshot)) return;
          if (Date.now() >= snapshot.next_attempt) await invoke("flush");
        } catch {
          /* Atomic replacement or a bounded network lock can be transient. */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Published client acknowledgement deadline exceeded");
    };
    stage = "background-upload";
    await wait(
      (s) =>
        (s.identity?.last_accepted_at ?? 0) > 0 &&
        s.batches.length === 0 &&
        Object.keys(s.open).length === 0,
    );
    // Exact owned identifiers only. No real traffic or aggregate statistics are read.
    const sql = (query: string) => psql(database, `SET ROLE "${owner}"; ${query}`);
    const owned = `FROM app_tracking.event_counts_v1 c JOIN app_tracking.event_batches_v1 b USING(tool_id,batch_id) WHERE b.tool_id='ferriki' AND b.installation_id=${quote(identity.id)}`;
    stage = "stored-counts";
    const counts = JSON.parse(
      await sql(
        `SELECT coalesce(jsonb_object_agg(metric,total),'{}'::jsonb) FROM (SELECT c.metric,sum(c.count) AS total ${owned} GROUP BY c.metric) t`,
      ),
    );
    assert.deepEqual(counts, { "language.use": 1, "resource.download": 1 });
    stage = "client-deletion";
    await invoke("delete");
    await wait((s) => s.identity === null && s.deleting === false);
    assert.equal(await sql(`SELECT count(*) ${owned}`), "0");
    assert.equal(
      await sql(
        `SELECT count(*) FROM app_tracking.event_batches_v1 WHERE tool_id='ferriki' AND installation_id=${quote(identity.id)}`,
      ),
      "0",
    );
    console.log(
      JSON.stringify({
        client_version: version,
        published_registry_dependency: true,
        noninteractive_permission: true,
        declined_collection: false,
        verified_download: true,
        background_upload: true,
        exact_owned_counts: true,
        authenticated_client_deletion: true,
        remaining_usage_rows: 0,
      }),
    );
  } finally {
    try {
      await cleanupEventProbe();
      cleaned = true;
    } finally {
      if (cleaned) await rm(directory, { recursive: true, force: true });
    }
  }
} catch {
  console.error(
    `Published event-client proof failed at ${stage}; no credentials, identifiers, reports, or provider details were logged.`,
  );
  process.exitCode = 1;
}
