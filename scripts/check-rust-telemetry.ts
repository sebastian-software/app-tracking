import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createTelemetryHandler, type TelemetryStorage } from "../src/telemetry/handler.ts";
import { psql, quote } from "./storage/psql.ts";

// This small storage fixture observes client wire/retry behavior only. It is
// not evidence for SQL transactions or expiry; optional runs inject real storage.
function fixtureStorage(): TelemetryStorage {
  const installations = new Map<string, { token: string; declaration: string; revoked: boolean }>();
  const receipts = new Map<string, { hash: string; received: string }>();
  const result = (value: { status: string; error?: string; received_at?: string }) => ({
    result: value,
    subrequests: 1,
    database_ms: 0,
  });
  return {
    async registerV1(tool, id, token, revision, consented, mode) {
      const existing = installations.get(id);
      const declaration = JSON.stringify([tool, revision, consented, mode]);
      if (existing)
        return result(
          existing.token !== token
            ? { status: "", error: "unauthorized" }
            : existing.revoked
              ? { status: "", error: "installation_revoked" }
              : existing.declaration !== declaration
                ? { status: "", error: "registration_conflict" }
                : { status: "duplicate" },
        );
      installations.set(id, { token, declaration, revoked: false });
      return result({ status: "registered" });
    },
    async submitV1(_tool, id, token, batch, hash) {
      const existing = installations.get(id);
      if (!existing) return result({ status: "", error: "installation_not_found" });
      if (existing.token !== token) return result({ status: "", error: "unauthorized" });
      if (existing.revoked) return result({ status: "", error: "installation_revoked" });
      const previous = receipts.get(batch);
      if (previous)
        return result(
          previous.hash !== hash
            ? { status: "", error: "batch_conflict" }
            : { status: "duplicate", received_at: previous.received },
        );
      const received = new Date().toISOString();
      receipts.set(batch, { hash, received });
      return result({ status: "accepted", received_at: received });
    },
    async deleteV1(_tool, id, token) {
      const existing = installations.get(id);
      if (!existing) return result({ status: "", error: "installation_not_found" });
      if (existing.token !== token) return result({ status: "", error: "unauthorized" });
      existing.revoked = true;
      return result({ status: "deleted" });
    },
  };
}

export async function checkRustTelemetry(storage?: TelemetryStorage, admin?: string) {
  for (const [source, packaged] of [
    ["contracts/telemetry-v1-policy.json", "telemetry-v1-policy.json"],
    ["test/fixtures/telemetry/consent-cases.json", "consent-cases.json"],
    ["test/fixtures/telemetry/valid.json", "telemetry-v1.json"],
  ])
    assert.deepEqual(
      JSON.parse(await readFile(source, "utf8")),
      JSON.parse(await readFile(`crates/app-tracking/fixtures/${packaged}`, "utf8")),
    );
  const handle = createTelemetryHandler(storage ?? fixtureStorage());
  const root = await mkdtemp(join(tmpdir(), "app-tracking-telemetry-"));
  const ids = new Set<string>();
  const names = new Set<string>();
  const active = new Set<Promise<void>>();
  let serverFailed = false;
  const observed: { method: string; body: string; authorizationHash: string }[] = [];
  let fault: "drop" | "tamper" | "unauthorized" | "conflict" | "stall" | undefined;
  let arrival: (() => void) | undefined;
  let phase = "setup",
    checks = 0;
  const server = createServer((incoming, outgoing) => {
    const work = (async () => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers(incoming.headers as Record<string, string>);
      assert.ok(headers.get("user-agent") === "app-tracking-telemetry-client");
      assert.ok(headers.get("cookie") === null);
      const id = incoming.url?.split("/")[3] ?? (body && JSON.parse(body).installation_id);
      // Only this fixture's private, durably persisted identities may reach
      // real storage or later administrative cleanup. Never trust a wire ID.
      const owned = await Promise.all(
        [...names].map(async (name) => {
          try {
            return (await state(name)).authority;
          } catch {
            return undefined;
          }
        }),
      );
      assert.ok(
        owned.some((a) => a?.id === id && headers.get("authorization") === `Bearer ${a.token}`),
        "request is not owned by this synthetic fixture",
      );
      ids.add(id);
      observed.push({
        method: incoming.method!,
        body,
        authorizationHash: createHash("sha256")
          .update(headers.get("authorization") ?? "")
          .digest("hex"),
      });
      arrival?.();
      arrival = undefined;
      const selected = fault;
      fault = undefined;
      const method = incoming.method!;
      const url = `http://127.0.0.1${incoming.url}`;
      if (selected === "unauthorized") headers.set("authorization", `Bearer ${"0".repeat(64)}`);
      if (selected === "conflict") {
        const changed = JSON.parse(body);
        changed.rows[0].count++;
        assert.equal(
          (await handle(new Request(url, { method, headers, body: JSON.stringify(changed) })))
            .status,
          200,
        );
      }
      let response = await handle(
        new Request(url, { method, headers, ...(method === "DELETE" ? {} : { body }) }),
      );
      if (selected === "stall") await new Promise((resolve) => setTimeout(resolve, 400));
      if (selected === "drop") {
        outgoing.destroy();
        return;
      }
      if (selected === "tamper") {
        const ack = await response.json();
        ack.payload_sha256 = "0".repeat(64);
        response = Response.json(ack, { headers: { "Cache-Control": "no-store" } });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(new Uint8Array(await response.arrayBuffer()));
    })();
    active.add(work);
    void work
      .catch(() => {
        serverFailed = true;
        outgoing.destroy();
      })
      .finally(() => active.delete(work));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const originHash = createHash("sha256").update(origin).digest("hex");
  const binary = join(
    process.env.CARGO_TARGET_DIR ?? "target",
    "debug",
    "examples",
    `telemetry-consumer${process.platform === "win32" ? ".exe" : ""}`,
  );
  function start(name: string, action: string) {
    names.add(name);
    const begin = performance.now();
    const child = spawn(binary, [origin, join(root, name), action], {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: undefined,
        RUNTIME_DATABASE_URL: undefined,
        BUNNY_API_KEY: undefined,
        GH_TOKEN: undefined,
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const done = new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, ms: performance.now() - begin });
        });
      },
    );
    return { child, done };
  }
  async function run(name: string, action: string) {
    const result = await start(name, action).done;
    assert.ok(
      result.code === (action === "ordinary" ? 7 : 0) && result.stderr === "",
      "synthetic child failed without safe output",
    );
    if (action === "ordinary") {
      assert.equal(result.stdout, '{"command":"ok"}\n');
      return { ms: result.ms };
    }
    return { ...JSON.parse(result.stdout), fixture_ms: result.ms };
  }
  const path = (name: string) => join(root, name, originHash, "dalo", "local", "state.json");
  const state = async (name: string) => JSON.parse(await readFile(path(name), "utf8"));
  // Fixture-only acceleration: exercise the real public run API without waiting
  // 60 seconds between scenarios. Production has no suppression-bypass API.
  async function due(name: string) {
    const data = await state(name);
    data.next_attempt_ms = 0;
    await writeFile(path(name), JSON.stringify(data));
  }
  async function settle() {
    await Promise.all([...active]);
    assert.ok(!serverFailed, "synthetic wire boundary failed");
  }
  async function eventually(name: string, action: string, wanted: string) {
    for (let i = 0; i < 4; i++) {
      await due(name);
      const result = await run(name, action);
      await settle();
      if (result.action === wanted) return result.fixture_ms as number;
      assert.equal(result.action, "retry_scheduled", "unexpected client result");
    }
    assert.fail("bounded synthetic attempts did not receive acknowledgement");
  }
  try {
    phase = "disabled and concurrent counts";
    const baseline = await run("disabled", "ordinary");
    assert.equal(observed.length, 0);
    checks++;
    await run("shared", "enable");
    const children = await Promise.all(
      Array.from({ length: 16 }, () => run("shared", "count-only")),
    );
    let counted = children.filter((r) => r.counted).length;
    assert.equal((await run("shared", "status")).unsent_invocations, counted);
    for (const child of children)
      if (!child.counted) {
        assert.equal((await run("shared", "count-only")).counted, true);
        counted++;
      }
    assert.equal(counted, 16);
    assert.equal((await state("shared")).authority, null);
    checks += 3;

    phase = "crash and lost registration acknowledgement";
    let markArrived!: () => void;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    arrival = markArrived;
    const pending = start("shared", "pump");
    await arrived;
    pending.child.kill("SIGKILL");
    await pending.done;
    await settle();
    const before = await state("shared");
    const crashIndex = observed.length - 1;
    assert.equal((await run("shared", "pump")).action, "idle");
    const registrationMs = await eventually("shared", "pump", "registered");
    assert.ok((await state("shared")).authority.id === before.authority.id);
    assert.ok(
      observed[crashIndex].body === observed.at(-1)?.body &&
        observed[crashIndex].authorizationHash === observed.at(-1)?.authorizationHash,
    );
    checks += 3;

    phase = "lost batch acknowledgement and new counts";
    fault = "drop";
    await due("shared");
    assert.equal((await run("shared", "flush")).action, "retry_scheduled");
    await settle();
    const immutable = (await state("shared")).batches[0];
    await run("shared", "count-only");
    await eventually("shared", "pump", "accepted");
    assert.ok(observed.filter((r) => r.method === "POST").every((r) => r.body === immutable.body));
    assert.equal((await run("shared", "status")).unsent_invocations, 1);
    checks += 3;
    if (admin) {
      const count = await psql(
        admin,
        `SELECT COALESCE(sum(count),0) FROM app_tracking.usage_counts WHERE installation_id=${quote(before.authority.id)}`,
      );
      assert.equal(count, "16", "real SQL receipt replay must not double count");
      checks++;
    }

    phase = "mismatched success acknowledgement";
    fault = "tamper";
    await due("shared");
    assert.equal((await run("shared", "flush")).action, "retry_scheduled");
    await settle();
    assert.equal((await state("shared")).batches.length, 1);
    await eventually("shared", "pump", "accepted");
    checks += 2;

    phase = "preview and command output";
    const preview = await run("shared", "preview");
    const privateState = await state("shared");
    assert.ok(!JSON.stringify(preview).includes(privateState.authority.token));
    const cachedTimes = [];
    for (let i = 0; i < 5; i++) cachedTimes.push((await run("shared", "ordinary")).ms);
    cachedTimes.sort((a, b) => a - b);
    checks += 2;

    phase = "batch conflict";
    fault = "conflict";
    await due("shared");
    assert.equal((await run("shared", "flush")).action, "paused");
    await settle();
    assert.equal((await run("shared", "status")).terminal_status, 409);
    assert.equal((await state("shared")).batches.length, 1);
    checks += 3;

    phase = "authenticated deletion";
    await run("shared", "delete");
    await eventually("shared", "pump", "deletion_complete");
    assert.equal((await run("shared", "status")).deletion, "confirmed");
    if (admin) {
      assert.equal(
        await psql(
          admin,
          `SELECT count(*) FROM app_tracking.usage_counts WHERE installation_id=${quote(before.authority.id)}`,
        ),
        "0",
      );
      checks++;
    }
    const afterDelete = observed.length;
    await run("shared", "ordinary");
    assert.equal(observed.length, afterDelete);
    checks += 2;

    phase = "wrong credential and revoked authority";
    for (const name of ["unauthorized", "revoked"]) {
      await run(name, "enable");
      await eventually(name, "pump", "registered");
      await run(name, "count-only");
      if (name === "unauthorized") fault = "unauthorized";
      else {
        const own = (await state(name)).authority;
        const response = await handle(
          new Request(`https://example.invalid/v1/installations/${own.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${own.token}` },
          }),
        );
        assert.equal(response.status, 204);
      }
      await due(name);
      assert.equal((await run(name, "flush")).action, "paused");
      await settle();
      assert.equal(
        (await run(name, "status")).terminal_status,
        name === "unauthorized" ? 401 : 410,
      );
      const requests: number = observed.length;
      await run(name, "ordinary");
      assert.equal(observed.length, requests);
      checks += 3;
    }
    phase = "bounded stalled request";
    await run("stalled", "enable");
    fault = "stall";
    const requestCount = observed.length;
    const stalled = await run("stalled", "pump");
    await settle();
    assert.equal(stalled.action, "retry_scheduled");
    assert.equal(observed.length, requestCount + 1, "one attempt, without automatic retries");
    checks += 2;
    return {
      checks,
      storage: storage ? "real database" : "wire fixture",
      concurrent_processes: 16,
      disabled_process_ms: Math.round(baseline.ms!),
      registration_ack_process_ms: Math.round(registrationMs!),
      cached_process_median_ms: Math.round(cachedTimes[2]),
      stalled_process_ms: Math.round(stalled.fixture_ms),
      public_routes_enabled: false,
    };
  } catch {
    throw new Error(
      `Rust telemetry integration failed at ${phase}; no credentials or payloads logged`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...active]);
    try {
      if (admin)
        for (const id of ids)
          await psql(
            admin,
            `DELETE FROM app_tracking.reporting_installations WHERE tool_id='dalo' AND installation_id=${quote(id)}`,
          );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) console.log(JSON.stringify(await checkRustTelemetry()));
