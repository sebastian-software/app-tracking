import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { psql, quote as q } from "./psql.ts";
import { identity, uuid7, maxRows, hash } from "../../test/storage/fixture.ts";
interface Result {
  result: { status: string; received_at?: string };
  subrequests: number;
  database_ms: number;
  elapsed_ms: number;
  request_bytes: number;
  instance: string;
  ordinal: number;
  heap_used_bytes: number | null;
  rss_bytes: number | null;
}
export async function verifyProof(base: string, secret: string) {
  const parsed = new URL(base);
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.startsWith("app-tracking-proof-") ||
    !parsed.hostname.endsWith(".b-cdn.net")
  )
    throw new Error("Dedicated proof target required");
  const ids: ReturnType<typeof identity>[] = [];
  let checks = 0;
  const measurements: Result[] = [];
  const clientTimes: number[] = [];
  let startupAttempts = 0;
  let diagnostic: Record<string, unknown> = { phase: "before_request" };
  async function send(
    route: string,
    body: unknown,
    pad = false,
    signal = AbortSignal.timeout(10_000),
  ) {
    const json = JSON.stringify(body);
    assert.ok(json.length <= 65536);
    const response = await fetch(new URL(route, base), {
      method: "POST",
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: pad ? json.padEnd(65536, " ") : json,
    });
    diagnostic = {
      phase: "http",
      status: response.status,
      cache: response.headers.get("cdn-cache"),
      policy: response.headers.get("cache-control"),
    };
    if (response.status !== 200) {
      try {
        const error = ((await response.clone().json()) as { error?: unknown }).error;
        if (typeof error === "string" && /^[a-z0-9_]{1,40}$/.test(error))
          diagnostic.application_error = error;
      } catch {}
    }
    assert.notEqual(response.headers.get("cdn-cache"), "HIT");
    assert.match(response.headers.get("cache-control") ?? "", /no-store|no-cache/);
    return response;
  }
  async function success(route: string, body: unknown, pad = false) {
    const started = performance.now();
    const response = await send(route, body, pad);
    clientTimes.push(performance.now() - started);
    assert.equal(response.status, 200);
    const result = (await response.json()) as Result;
    diagnostic = {
      phase: "result",
      subrequests: result.subrequests,
      elapsed_ms: result.elapsed_ms,
      request_bytes: result.request_bytes,
      status: result.result?.status,
    };
    assert.equal(result.subrequests, 1);
    assert.ok(result.elapsed_ms < 3000);
    measurements.push(result);
    return result;
  }
  async function registration() {
    const item = identity();
    ids.push(item);
    await success("/proof/register", {
      id: item.id,
      token_hash: item.tokenHash,
      consented_at: item.consentedAt,
    });
    return item;
  }
  const body = (item: ReturnType<typeof identity>, rows = maxRows()) => ({
    id: item.id,
    token_hash: item.tokenHash,
    batch_id: uuid7(),
    content_hash: hash(JSON.stringify(rows)),
    rows,
  });
  try {
    // Seed one immutable synthetic identity via the migration channel. The first
    // request to the fresh edge deployment can then be a maximum-size batch.
    const admin = process.env.MIGRATION_DATABASE_URL;
    if (!admin) throw new Error("Migration connection is required for cold seeding");
    const item = identity();
    ids.push(item);
    await psql(
      admin,
      `SELECT app_tracking.register_installation('dalo',${q(item.id)},${q(item.tokenHash)},'telemetry-v1',${q(item.consentedAt)},'local')`,
    );
    const max = body(item);
    let first: Result | undefined;
    // DNS/platform activation can precede the first executed invocation. Retry
    // the exact same immutable batch; record all activation attempts separately.
    for (let attempt = 0; attempt < 12; attempt++) {
      startupAttempts++;
      try {
        first = await success("/proof/submit", max, true);
        break;
      } catch {
        console.log(JSON.stringify({ activation_attempt: attempt + 1, ...diagnostic }));
        if (attempt === 11) throw new Error("Fresh deployment unavailable");
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    assert.ok(first);
    assert.ok(["accepted", "duplicate"].includes(first.result.status));
    assert.equal(first.request_bytes, 65536);
    checks += 2;
    const denied = await fetch(new URL("/proof/submit", base), { method: "POST" });
    assert.equal(denied.status, 401);
    checks++;
    await registration();
    checks++;
    const concurrency = body(item);
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => success("/proof/submit", concurrency)),
    );
    assert.equal(replies.filter((r) => r.result.status === "accepted").length, 1);
    assert.equal(replies.filter((r) => r.result.status === "duplicate").length, 7);
    checks += 2;
    const conflict = await send("/proof/submit", { ...concurrency, content_hash: hash("changed") });
    assert.equal(conflict.status, 503);
    assert.deepEqual(await conflict.json(), { error: "22023" });
    checks++;
    const lost = body(item);
    assert.equal((await send("/proof/submit", { ...lost, discard_ack: true })).status, 503);
    assert.equal((await success("/proof/submit", lost)).result.status, "duplicate");
    checks++;
    const timed = body(item);
    await assert.rejects(send("/proof/submit", timed, false, AbortSignal.timeout(1)));
    // The remote outcome is deliberately unknown; identical retry is safe either way.
    assert.ok(
      ["accepted", "duplicate"].includes((await success("/proof/submit", timed)).result.status),
    );
    checks++;
    const broken = body(item, [{ ...maxRows()[0]!, count: 0 }]);
    assert.equal((await send("/proof/submit", broken)).status, 503);
    // Same batch ID can now accept because the failed transaction committed no receipt.
    const fixed = { ...broken, rows: [maxRows()[0]!] };
    fixed.content_hash = hash(JSON.stringify(fixed.rows));
    assert.equal((await success("/proof/submit", fixed)).result.status, "accepted");
    checks++;
    for (let i = 0; i < 10; i++) await success("/proof/submit", body(item), true);
    checks++;
    await success("/proof/revoke", { id: item.id, token_hash: item.tokenHash });
    assert.equal((await send("/proof/submit", max)).status, 503);
    checks++;
    const maxMeasured = measurements.filter((r) => r.request_bytes === 65536);
    const sorted = maxMeasured.map((r) => r.elapsed_ms).sort((a, b) => a - b);
    const heap = measurements.map((r) => r.heap_used_bytes).filter((v): v is number => v !== null);
    return {
      checks,
      rows_per_maximum_batch: 256,
      maximum_request_bytes: 65536,
      samples: maxMeasured.length,
      first_maximum_ms: first.elapsed_ms,
      first_maximum_client_ms: clientTimes[0],
      startup_attempts: startupAttempts,
      first_maximum_invocation: first.ordinal,
      p50_maximum_ms: sorted[Math.floor(sorted.length / 2)],
      max_maximum_ms: sorted.at(-1),
      max_database_ms: Math.max(...measurements.map((r) => r.database_ms)),
      subrequests_per_operation: 1,
      observed_instances: new Set(measurements.map((r) => r.instance)).size,
      first_observed_invocation: Math.min(...measurements.map((r) => r.ordinal)),
      maximum_observed_heap_bytes: heap.length ? Math.max(...heap) : null,
      memory_scope: "runtime heap snapshots; not peak active memory or process RSS",
      cache: "no shared cache hits",
      telemetry_routes_enabled: false,
    };
  } finally {
    // Revoke only this run's synthetic installations. Normal retention handles tombstones.
    for (const item of ids)
      await success("/proof/revoke", { id: item.id, token_hash: item.tokenHash });
  }
}
if (import.meta.main) {
  try {
    const { base } = JSON.parse(await readFile(".deployment/proof-target.json", "utf8"));
    const secret = process.env.PROOF_AUTH_TOKEN;
    if (!secret) throw new Error("Proof token missing");
    const result = await verifyProof(base, secret);
    await writeFile("dist/storage-proof-results.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch {
    console.error("Live storage proof failed. Inspect privately; no provider details were logged.");
    process.exitCode = 1;
  }
}
