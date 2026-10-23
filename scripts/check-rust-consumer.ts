import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHandler } from "../src/handler.ts";
import { npmDocument } from "../test/helpers.ts";

const fixture = JSON.parse(await readFile("test/fixtures/version.json", "utf8"));
assert.deepEqual(
  JSON.parse(await readFile("crates/app-tracking/fixtures/version.json", "utf8")),
  fixture,
);
let requests = 0;
let upstreams = 0;
const handle = createHandler({
  fetch: async () => {
    upstreams++;
    return Response.json(npmDocument());
  },
});
const server = createServer((incoming, outgoing) => {
  requests++;
  const request = new Request(`http://127.0.0.1${incoming.url}`, {
    headers: incoming.headers as Record<string, string>,
  });
  assert.equal(request.headers.get("user-agent"), "app-tracking-update-client");
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.headers.get("cookie"), null);
  assert.equal(new URL(request.url).search, "");
  void handle(request).then(async (response) => {
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const root = await mkdtemp(join(tmpdir(), "app-tracking-consumer-"));
const binary = join(
  process.env.CARGO_TARGET_DIR ?? "target",
  "debug",
  "examples",
  `update-consumer${process.platform === "win32" ? ".exe" : ""}`,
);

async function run(cache: string, version = "1.0.0", mode = "enabled", distribution = "npm") {
  const start = performance.now();
  const child = spawn(binary, [origin, cache, version, mode, distribution]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => (stdout += value));
  child.stderr.on("data", (value) => (stderr += value));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 7);
  assert.equal(stdout, '{"command":"ok"}\n');
  return { stderr, ms: performance.now() - start };
}
try {
  const cache = join(root, "ordinary");
  const cold = await run(cache);
  assert.match(cold.stderr, /dalo 1\.2\.3\. Run: npm install -g getdalo/);
  assert.equal((await run(cache)).stderr, "");
  assert.equal((await run(cache, "1.2.3")).stderr, "");
  assert.equal(requests, 1);
  for (const mode of ["disabled", "offline"]) {
    const path = join(root, mode);
    assert.equal((await run(path, "1.0.0", mode)).stderr, "");
    await assert.rejects(access(path));
  }
  assert.equal(requests, 1);
  assert.equal((await run(join(root, "unsupported"), "1.0.0", "enabled", "crates")).stderr, "");
  assert.equal(requests, 2);
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => run(join(root, "shared"))));
  assert.equal(requests, 3, "Concurrent processes must share one HTTP lookup");
  assert.equal(
    concurrent.filter((result) => result.stderr !== "").length,
    1,
    "Only one process offers the notice",
  );
  assert.equal(upstreams, 1, "The real handler owns upstream caching");
  const warmTimes = [];
  for (let i = 0; i < 10; i++) warmTimes.push((await run(cache)).ms);
  warmTimes.sort((a, b) => a - b);
  const disabledTimes = [];
  for (let i = 0; i < 10; i++)
    disabledTimes.push((await run(join(root, "disabled-baseline"), "1.0.0", "disabled")).ms);
  disabledTimes.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      result: "Rust consumer + real TypeScript handler passed",
      cold_process_ms: Math.round(cold.ms),
      warm_process_median_ms: Math.round(warmTimes[5]),
      disabled_process_median_ms: Math.round(disabledTimes[5]),
      requests,
      concurrent_processes: 12,
    }),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
}
