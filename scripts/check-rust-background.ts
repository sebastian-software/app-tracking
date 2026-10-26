import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryHandler } from "../src/telemetry/handler.ts";
import { fixtureStorage } from "./check-rust-telemetry.ts";

const root = await mkdtemp(join(tmpdir(), "app-tracking-background-"));
const executable = join(
  process.env.CARGO_TARGET_DIR ?? "target",
  "debug",
  "examples",
  `background-consumer${process.platform === "win32" ? ".exe" : ""}`,
);
const handler = createTelemetryHandler(fixtureStorage());
let release: (() => void) | undefined;
let arrived: (() => void) | undefined;
let requests = 0;
const active = new Set<Promise<void>>();
const server = createServer((incoming, outgoing) => {
  const task = (async () => {
    requests++;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const response = await handler(
      new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(incoming.method === "DELETE" ? {} : { body }),
      }),
    );
    arrived?.();
    arrived = undefined;
    if (release) await gate;
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  })();
  active.add(task);
  task
    .finally(() => active.delete(task))
    .catch(() => {
      outgoing.destroy();
    });
});
let gate: Promise<void>;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
function run(action: string, token?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, [action, ...(token ? [token] : [])], {
      env: { ...process.env, APP_TRACKING_PROBE_ORIGIN: origin, APP_TRACKING_PROBE_STATE: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => {
      stdout += part;
    });
    child.stderr.on("data", (part) => {
      stderr += part;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function status() {
  const result = await run("status");
  if (result.code === 1) return undefined; // Nonblocking state locks can be busy during ACK.
  assert.equal(result.code, 0);
  return JSON.parse(result.stdout);
}
async function statePath(directory = root): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "state.json") return join(directory, entry.name);
    if (entry.isDirectory()) {
      try {
        return await statePath(join(directory, entry.name));
      } catch {
        /* try next scope */
      }
    }
  }
  throw new Error("Fixture state not found");
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Background operation did not complete");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function allowNextFixtureAttempt() {
  const path = await statePath();
  const state = JSON.parse(await readFile(path, "utf8"));
  state.next_attempt_ms = 0;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}
try {
  assert.equal((await run("ordinary")).code, 7);
  assert.equal(requests, 0, "No consent must not launch a network worker");
  assert.equal((await run("enable")).code, 0);
  assert.equal((await run("offline")).code, 0);
  assert.equal(requests, 0);
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const parent = await run("ordinary");
  assert.deepEqual(parent, { code: 7, stdout: '{"command":"ok"}\n', stderr: "" });
  await Promise.race([
    arrival,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("No worker request")), 10_000).unref(),
    ),
  ]);
  assert.equal(requests, 1);
  const pending = JSON.parse(await readFile(await statePath(), "utf8"));
  assert.equal(pending.authority.registered, false, "Parent exited before registration ACK");
  release!();
  release = undefined;
  await waitFor(
    async () => JSON.parse(await readFile(await statePath(), "utf8")).authority.registered,
  );
  await waitFor(async () => (await status())?.unsent_invocations === 2);
  assert.equal((await run("flush")).code, 0);
  assert.equal(requests, 1, "Flush must honor minimum retry/attempt interval");
  await allowNextFixtureAttempt();
  assert.equal((await run("flush")).code, 0);
  await waitFor(async () => (await status())?.unsent_invocations === 0);
  assert.equal(requests, 2);
  assert.equal((await run("--app-tracking-worker-v1", "0".repeat(64))).code, 0);
  assert.equal(requests, 2, "An unprepared worker must not send or count");
  assert.equal((await run("delete")).code, 0);
  await waitFor(async () => (await status())?.deletion === "confirmed");
  assert.equal(requests, 3);
  console.log(
    JSON.stringify({
      parent_exits_before_ack: true,
      background_upload: true,
      background_deletion: true,
      consent_offline_retry_preserved: true,
    }),
  );
} finally {
  release?.();
  await Promise.allSettled([...active]);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
