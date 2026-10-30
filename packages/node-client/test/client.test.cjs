const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { after, beforeEach, test } = require("node:test");

function bound(child) {
  const timer = setTimeout(() => child.kill(), 5000);
  child.once("exit", () => clearTimeout(timer));
  return child;
}

let fixture, installed, Client, TrackingError, UpdateClient, UpdateError, CliClient;
// These fixtures exercise a local, interactive-user profile independently of
// the CI host. A separate test verifies environment restrictions explicitly.
for (const name of [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "DO_NOT_TRACK",
  "APP_TRACKING_TELEMETRY",
  "APP_TRACKING_CI",
])
  delete process.env[name];

const installedFixture = (async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), "app-tracking-node-test-"));
  const source = resolve(__dirname, "..");
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", fixture], {
      cwd: source,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
    }),
  );
  installed = join(fixture, "node_modules/@sebastian-software/app-tracking");
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(fixture, Object.values(packed)[0].filename),
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
    },
  );
  ({ Client, TrackingError, UpdateClient, UpdateError, CliClient } = require(installed));
  const typeConsumer = join(fixture, "consumer.mts");
  await fs.writeFile(
    typeConsumer,
    `import { Client, TrackingError, UpdateClient, CliClient, type Update, type CliStatus, type Status, type VerifiedDownload } from '@sebastian-software/app-tracking';\nconst c = new Client({origin:'https://example.com',stateRoot:'/synthetic/private',tool:'ferriki',version:'1.2.3'});\nconst s: Promise<Status> = c.status();\nconst d: Promise<VerifiedDownload> = c.download({id:'grammar',url:'https://example.com/grammar',bytes:0,sha256:'0'.repeat(64)});\nconst code: string = new TrackingError('Busy').code;\nconst updates = new UpdateClient({origin:'https://example.com',cacheRoot:'/synthetic/cache',tool:'ardo',version:'1.0.0',distribution:'github'});\nconst update: Promise<Update | undefined> = updates.check('enabled');\nconst cli = new CliClient({origin:'https://example.com',stateRoot:'/synthetic/private',tool:'ardo',version:'1.0.0',invocation:{metric:'cli.invocation',categories:{build:{command:'build'}}}});\nconst status: Promise<CliStatus> = cli.status();\n`,
  );
  const root = resolve(__dirname, "../../..");
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--typeRoots",
      join(root, "node_modules/@types"),
      typeConsumer,
    ],
    { cwd: fixture, encoding: "utf8" },
  );
})();

// Node.js 22.0.0 does not await async before hooks (nodejs/node#52764).
// Await the same initialization in each test; the package is installed once.
beforeEach(() => installedFixture);

after(async () => {
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

async function client(extra = {}) {
  return new Client({
    origin: "http://127.0.0.1:1",
    stateRoot: join(await fs.mkdtemp(join(fixture, "state-")), "private"),
    tool: "ferriki",
    version: "1.2.3",
    interaction: "never",
    ...extra,
  });
}

const dimensions = { language: "rust", source: "explicit" };
const body = Buffer.from("synthetic resource\n");
function resource(origin, path = "/resource") {
  return {
    id: "grammar-rust",
    url: `${origin}${path}`,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function server(handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return {
    origin: `http://127.0.0.1:${instance.address().port}`,
    async close() {
      instance.closeAllConnections();
      await new Promise((resolve) => instance.close(resolve));
    },
  };
}

test("packed package supports CJS and ESM, includes licenses, and does nothing on construction", async () => {
  const imported = await import(pathToFileURL(join(installed, "dist/index.mjs")).href);
  assert.equal(typeof imported.Client, "function");
  await fs.access(join(installed, "LICENSE-MIT"));
  await fs.access(join(installed, "LICENSE-APACHE"));
  const stateRoot = join(fixture, "untouched");
  const c = await client({ stateRoot });
  assert.equal(await c.record("language.use", dimensions), "suppressed");
  assert.equal(await c.requestOptIn("Help improve language support."), "unavailable");
  assert.deepEqual(await c.preview(), { open: [], batches: [] });
  assert.equal((await c.status()).decision, "undecided");
  await assert.rejects(fs.stat(stateRoot), { code: "ENOENT" });
});

test("grants/refusals persist, operations retain call order, and withdrawal discards unsent data", async () => {
  const stateRoot = join(fixture, "shared-state");
  const a = await client({ stateRoot });
  const b = await client({ stateRoot });
  const grant = a.setOptIn(true);
  const record = a.record("language.use", dimensions);
  await grant;
  assert.equal(await record, "counted");
  assert.equal(await b.requestOptIn("Help improve language support."), "granted");
  assert.equal((await b.status()).collectOptIn, true);
  assert.equal((await b.preview()).open[0].count, 1);
  assert.ok(!JSON.stringify(await b.preview()).includes("token"));
  await a.setOptIn(false);
  assert.equal(await b.requestOptIn("Help improve language support."), "declined");
  assert.deepEqual(await b.preview(), { open: [], batches: [] });
  assert.equal(await b.record("language.use", dimensions), "suppressed");
});

test("registered dimensions and configuration reject invalid inputs with sanitized errors", async () => {
  const c = await client();
  await c.setOptIn(true);
  await assert.rejects(
    c.record("language.use", { language: "private-path", source: "explicit" }),
    (e) =>
      e instanceof TrackingError &&
      e.code === "Configuration" &&
      !e.message.includes("private-path"),
  );
  await assert.rejects(c.setOptIn("yes"), { code: "Configuration" });
  assert.equal((await c.status()).collectOptIn, true);
  assert.throws(
    () =>
      new Client({
        origin: "https://example.com",
        stateRoot: "relative",
        tool: "ferriki",
        version: "1.2.3",
      }),
    { code: "Configuration" },
  );
  await assert.rejects(client({ tool: "unregistered" }), { code: "Configuration" });
});

test("offline collection queues locally; deletion and disabling discard unsent rows", async () => {
  const c = await client({ policy: { offline: true } });
  await c.setOptIn(true);
  assert.equal(await c.record("language.use", dimensions), "counted");
  assert.equal(await c.flushInBackground(), false);
  await c.delete();
  const status = await c.status();
  assert.equal(status.disabled, true);
  assert.equal(status.deletionPending, true);
  assert.equal(status.decision, "declined");
  assert.deepEqual(await c.preview(), { open: [], batches: [] });
  assert.equal(await c.flushInBackground(), false);
});

test("CI and do-not-track environment restrictions cannot be bypassed by options", async () => {
  process.env.CI = "true";
  const ci = await client({ policy: { ci: false } });
  await ci.setOptIn(true);
  assert.equal(await ci.record("language.use", dimensions), "suppressed");
  assert.equal(await ci.requestOptIn("Help improve language support."), "unavailable");
  delete process.env.CI;
  process.env.DO_NOT_TRACK = "1";
  const veto = await client({ policy: { doNotTrack: false } });
  await veto.setOptIn(true);
  assert.equal(await veto.record("language.use", dimensions), "suppressed");
  delete process.env.DO_NOT_TRACK;
});

test("download verifies streaming bytes, exposes a temporary file, and never forwards credentials", async () => {
  let headers;
  const s = await server((req, res) => {
    headers = req.headers;
    res.end(body);
  });
  try {
    const c = await client();
    await c.setOptIn(true);
    const download = await c.download({
      ...resource(s.origin),
      reporting: { metric: "resource.download", dimensions: { kind: "grammar" } },
    });
    assert.equal(download.bytes, body.length);
    assert.deepEqual(await fs.readFile(download.path), body);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    const preview = await c.preview();
    assert.equal(preview.open[0].metric, "resource.download");
    assert.ok(!JSON.stringify(preview).includes(s.origin));
    await download.close();
    await download.close();
    await assert.rejects(fs.stat(download.path), { code: "ENOENT" });
  } finally {
    await s.close();
  }
});

test("invalid downloads, redirects, cancellation, and offline mode do not return artifacts", async () => {
  const s = await server((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/resource" });
      res.end();
    } else res.end(body);
  });
  try {
    const c = await client();
    await assert.rejects(c.download({ ...resource(s.origin), sha256: "0".repeat(64) }), {
      code: "Integrity",
    });
    await assert.rejects(c.download(resource(s.origin, "/redirect")), { code: "HttpStatus" });
    await assert.rejects(c.download(resource(s.origin), { maxBytes: 1 }), {
      code: "Configuration",
    });
    await assert.rejects(c.download(resource(s.origin), { signal: AbortSignal.abort() }), {
      code: "Cancelled",
    });
    await assert.rejects(c.download({ ...resource(s.origin), bytes: 1.5 }), {
      code: "Configuration",
    });
    const offline = await client({ policy: { offline: true } });
    await assert.rejects(offline.download(resource(s.origin)), { code: "Offline" });
    assert.equal((await c.status()).decision, "undecided");
  } finally {
    await s.close();
  }
});

test("a slow download leaves the Node event loop responsive and accepts cancellation", async () => {
  const s = await server((_req, res) => {
    res.write(body.subarray(0, 1));
    const timer = setTimeout(() => res.end(body.subarray(1)), 200);
    res.on("close", () => clearTimeout(timer));
  });
  try {
    const c = await client();
    const abort = new AbortController();
    const pending = c.download(resource(s.origin), { signal: abort.signal });
    let ticked = false;
    setTimeout(() => {
      ticked = true;
      abort.abort();
    }, 20);
    await assert.rejects(pending, { code: "Cancelled" });
    assert.equal(ticked, true);
  } finally {
    await s.close();
  }
});

test(
  "dedicated worker sends maintained event batches, acknowledges them, and deletes the identity",
  { timeout: 15_000 },
  async () => {
    let receivedResolve, deletionResolve;
    let received = new Promise((resolve) => {
      receivedResolve = resolve;
    });
    const deletion = new Promise((resolve) => {
      deletionResolve = resolve;
    });
    let event;
    const s = await server(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.method === "DELETE") {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        deletionResolve();
        return;
      }
      event = JSON.parse(raw);
      const { eventBatch } = await import("../../../dist/node-client-test/event-validator.mjs");
      eventBatch(event);
      assert.match(req.headers.authorization, /^Bearer [a-f0-9]{64}$/);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          batch_id: event.batch_id,
          payload_sha256: createHash("sha256").update(raw).digest("hex"),
        }),
      );
      receivedResolve();
    });
    try {
      const c = await client({ origin: s.origin });
      await c.setOptIn(true);
      await c.record("language.use", dimensions);
      assert.equal(await c.flushInBackground(), true);
      await received;
      assert.equal(event.tool_id, "ferriki");
      assert.deepEqual(event.rows[0].dimensions, dimensions);
      await eventually(async () => (await c.status()).queuedBatches === 0);
      assert.equal(await c.flushInBackground(), false);
      await c.delete();
      assert.equal(await c.flushInBackground(), true);
      await deletion;
      await eventually(async () => !(await c.status()).deletionPending);
    } finally {
      await s.close();
    }
  },
);

async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if (await check()) return;
    } catch (error) {
      if (error.code !== "Busy") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("background state did not settle");
}

test(
  "parallel installed-package processes preserve counts or return explicit bounded contention",
  { timeout: 15_000 },
  async () => {
    const stateRoot = join(fixture, "parallel-state");
    const c = await client({ stateRoot });
    await c.setOptIn(true);
    const script = `
      const { Client } = require(${JSON.stringify(installed)});
      const c = new Client(${JSON.stringify({ origin: "http://127.0.0.1:1", stateRoot, tool: "ferriki", version: "1.2.3", interaction: "never" })});
      (async () => {
        let counted = 0, busy = 0;
        for (let n = 0; n < 20; n++) {
          try {
            await c.record("language.use", ${JSON.stringify(dimensions)});
            counted++;
          } catch (error) {
            if (error.code !== "Busy") throw error;
            busy++;
          }
        }
        process.stdout.write(JSON.stringify({ counted, busy }));
      })().catch((error) => {
        const code = typeof error?.code === "string" && /^[A-Za-z]+$/.test(error.code)
          ? error.code : "Unknown";
        process.stderr.write("record failed: " + code);
        process.exitCode = 1;
      });`;
    const results = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = spawn(process.execPath, ["-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        const [code, signal] = await once(child, "close");
        assert.equal(code, 0, `child exited with code ${code}, signal ${signal}: ${stderr}`);
        const result = JSON.parse(stdout);
        assert.ok(Number.isInteger(result.counted) && result.counted >= 0);
        assert.ok(Number.isInteger(result.busy) && result.busy >= 0);
        assert.equal(result.counted + result.busy, 20);
        return result;
      }),
    );
    const counted = results.reduce((total, result) => total + result.counted, 0);
    // Busy is a valid result and carries no fairness or minimum-throughput promise.
    // Check every acknowledged write, then prove progress after contention ends.
    assert.equal((await c.preview()).open[0]?.count ?? 0, counted);
    assert.equal(await c.record("language.use", dimensions), "counted");
    assert.equal((await c.preview()).open[0].count, counted + 1);
  },
);

function stateFile(stateRoot, origin = "http://127.0.0.1:1") {
  return join(
    stateRoot,
    createHash("sha256").update(origin).digest("hex"),
    "ferriki",
    "node-events-v1",
    "state.json",
  );
}

test("lazy project normalization agrees with every shared Rust golden fixture", async () => {
  const fixtures = JSON.parse(
    await fs.readFile(
      resolve(__dirname, "../../../crates/app-tracking/fixtures/project-identity-v1.json"),
      "utf8",
    ),
  );
  for (const fixture of fixtures.cases) {
    let calls = 0;
    const c = await client({
      projectContext: () => {
        calls++;
        return {
          origin: fixture.origin_unavailable ? undefined : fixture.origin,
          packageJson: fixture.package === null ? undefined : JSON.stringify(fixture.package),
        };
      },
    });
    await c.record("language.use", dimensions);
    assert.equal(calls, 0, fixture.name);
    await c.setOptIn(true);
    await c.record("language.use", dimensions);
    await c.record("language.use", dimensions);
    const row = (await c.preview()).open[0];
    assert.equal(calls, 1, fixture.name);
    assert.equal(row.project_id ?? null, fixture.project_id, fixture.name);
    assert.equal(
      row.project_id_version ?? null,
      fixture.project_id === null ? null : 1,
      fixture.name,
    );
  }
});

test("Node never imports Rust credentials or grants from a neighboring state directory", async () => {
  const stateRoot = join(fixture, "separate-runtimes");
  const nodeFile = stateFile(stateRoot);
  const rustDirectory = resolve(nodeFile, "../../events-v1");
  await fs.mkdir(rustDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(rustDirectory, "state.json"),
    JSON.stringify({ opt_in: true, identity: { token: "synthetic-private-credential" } }),
    { mode: 0o600 },
  );
  const c = await client({ stateRoot });
  assert.equal((await c.status()).decision, "undecided");
  assert.equal(await c.record("language.use", dimensions), "suppressed");
  await assert.rejects(fs.stat(nodeFile), { code: "ENOENT" });
});

test(
  "interrupted writes preserve the last committed state and a crashed process lock can recover",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const stateRoot = join(fixture, "crash-state");
    const c = await client({ stateRoot });
    await c.setOptIn(true);
    await c.record("language.use", dimensions);
    const file = stateFile(stateRoot);
    const script = `const {Client}=require(${JSON.stringify(installed)}); const c=new Client({origin:'http://127.0.0.1:1',stateRoot:${JSON.stringify(stateRoot)},tool:'ferriki',version:'1.2.3',interaction:'never',projectContext:()=>{process.stdout.write('locked'); return new Promise(()=>{});}}); c.record('language.use',${JSON.stringify(dimensions)}).catch(()=>{process.exitCode=1}); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout, "data");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await fs.writeFile(`${file}.interrupted.tmp`, '{"incomplete":', { mode: 0o600 });
      // Advance only the orphaned lease clock after confirming the owner exited.
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(`${file}.lock`, past, past);
      assert.equal((await c.preview()).open[0].count, 1);
      assert.equal(await c.record("language.use", dimensions), "counted");
      assert.equal((await c.preview()).open[0].count, 2);
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test(
  "invalid receipts retain an immutable batch and the retry uses the same identity, ID, and bytes",
  { timeout: 15_000 },
  async () => {
    const requests = [];
    const s = await server(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ raw, authorization: req.headers.authorization });
      const batch = JSON.parse(raw);
      res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
      res.end(
        JSON.stringify({
          batch_id: batch.batch_id,
          payload_sha256:
            requests.length === 1 ? "0".repeat(64) : createHash("sha256").update(raw).digest("hex"),
        }),
      );
    });
    try {
      const stateRoot = join(fixture, "retry-state");
      const c = await client({ origin: s.origin, stateRoot });
      await c.setOptIn(true);
      await c.record("language.use", dimensions);
      assert.equal(await c.flushInBackground(), true);
      const file = stateFile(stateRoot, s.origin);
      await eventually(async () => JSON.parse(await fs.readFile(file, "utf8")).failures === 1);
      await eventually(async () => {
        try {
          await fs.stat(join(resolve(file, ".."), "network.lock"));
          return false;
        } catch {
          return true;
        }
      });
      const state = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(state.batches.length, 1);
      assert.equal(await c.flushInBackground(), false);
      // Skip the fixture's one-minute retry delay without changing its batch.
      state.nextAttempt = 0;
      await fs.writeFile(file, JSON.stringify(state));
      assert.equal(await c.flushInBackground(), true);
      await eventually(async () => (await c.status()).queuedBatches === 0);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0]);
    } finally {
      await s.close();
    }
  },
);

test("queued work loses authority immediately on withdrawal, including stale worker nonces", async () => {
  const stateRoot = join(fixture, "withdrawal-state");
  const c = await client({ stateRoot });
  await c.setOptIn(true);
  await c.record("language.use", dimensions);
  const file = stateFile(stateRoot);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const nonce = "a".repeat(64);
  state.job = { nonce, generation: state.generation, created: Date.now(), batch: "b".repeat(64) };
  await fs.writeFile(file, JSON.stringify(state));
  await c.setOptIn(false);
  assert.equal(await c.runBackgroundWorker(nonce), false);
  assert.deepEqual(await c.preview(), { open: [], batches: [] });
});

test("changed metric scope discards old data before validation and requires another grant", async () => {
  const stateRoot = join(fixture, "changed-scope");
  const c = await client({ stateRoot });
  await c.setOptIn(true);
  await c.record("language.use", dimensions);
  const file = stateFile(stateRoot);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.optInScope = "0".repeat(64);
  Object.values(state.open)[0].dimensions.language = "obsolete-value";
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await c.status()).collectOptIn, false);
  assert.equal(await c.requestOptIn("Explain the new scope."), "unavailable");
  assert.equal(await c.record("language.use", dimensions), "suppressed");
  assert.deepEqual(await c.preview(), { open: [], batches: [] });
  await c.setOptIn(true);
  assert.equal(await c.record("language.use", dimensions), "counted");
});

test("additional permissions require independent choices and exact authenticated acknowledgements", async () => {
  let mode = "mismatch";
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      tool: req.headers["app-tracking-tool"],
      body: JSON.parse(body),
    });
    if (mode === "redirect") {
      res.writeHead(307, { location: "/elsewhere" });
      res.end();
      return;
    }
    if (mode === "malformed") {
      res.writeHead(200, { "cache-control": "no-store" });
      res.end('{"schema_version":1,"schema_version":1}');
      return;
    }
    const receipt = JSON.parse(body);
    if (mode === "mismatch") receipt.changed_at++;
    res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" });
    res.end(JSON.stringify(receipt));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const c = await client({ origin: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(c.setHistoryOptIn(true), { code: "AdditionalPermission" });
    await c.setOptIn(true);
    await assert.rejects(c.setPublicUsageOptIn(true), { code: "AdditionalPermission" });
    await c.setHistoryOptIn(true);
    assert.deepEqual(await c.historyStatus(), { decision: "granted", pending: true });
    assert.equal(await c.syncHistoryPermission(), false);
    mode = "malformed";
    assert.equal(await c.syncHistoryPermission(), false);
    mode = "redirect";
    assert.equal(await c.syncHistoryPermission(), false);
    mode = "exact";
    assert.equal(await c.syncHistoryPermission(), true);
    assert.deepEqual(await c.historyStatus(), { decision: "granted", pending: false });
    await c.setPublicUsageOptIn(true);
    assert.equal(await c.syncPublicUsagePermission(), true);
    assert.match(requests[0].url, /^\/v1\/history-permissions\/events\/[a-f0-9]{64}$/);
    assert.match(requests[0].auth, /^Bearer [a-f0-9]{64}$/);
    assert.equal(requests[0].tool, "ferriki");
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests.at(-1).body.revision, "public-usage-v1");
    await c.setHistoryOptIn(false);
    assert.deepEqual(await c.publicUsageStatus(), { decision: "declined", pending: true });
    await c.setHistoryOptIn(true);
    assert.equal((await c.publicUsageStatus()).decision, "declined");
    await c.setOptIn(false);
    assert.equal((await c.historyStatus()).decision, "declined");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("additional permission choices stay pending offline and survive ordinary re-enabling", async () => {
  const c = await client({ policy: { offline: true } });
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  await c.setPublicUsageOptIn(true);
  assert.equal(await c.syncHistoryPermission(), false);
  await c.setDisabled(true);
  assert.deepEqual(await c.historyStatus(), { decision: "declined", pending: true });
  assert.deepEqual(await c.publicUsageStatus(), { decision: "declined", pending: true });
  await c.setDisabled(false);
  assert.equal(await c.requestHistoryOptIn("Privacy settings"), "declined");
});

test("unknown and stale affirmative scopes require a fresh choice", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "scope-")), "private");
  const c = await client({ stateRoot });
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  const path = stateFile(stateRoot);
  const state = JSON.parse(await fs.readFile(path, "utf8"));
  state.history.revision = "future-scope";
  state.history.confirmed = true;
  await fs.writeFile(path, JSON.stringify(state), { mode: 0o600 });
  assert.equal((await c.historyStatus()).decision, "undecided");
  assert.equal(await c.syncHistoryPermission(), false);
  await c.setHistoryOptIn(true);
  assert.equal((await c.historyStatus()).pending, true);
  const fresh = JSON.parse(await fs.readFile(path, "utf8"));
  fresh.history.changedAt = Date.now() - 90 * 86400000;
  await fs.writeFile(path, JSON.stringify(fresh), { mode: 0o600 });
  assert.equal(await c.requestHistoryOptIn("Privacy settings"), "unavailable");
  await c.setHistoryOptIn(true);
  assert.ok(
    JSON.parse(await fs.readFile(path, "utf8")).history.changedAt > fresh.history.changedAt,
  );
  await c.delete();
  assert.equal((await c.historyStatus()).decision, "declined");
});

test("a concurrent withdrawal cannot overtake an in-flight permission acknowledgement", async () => {
  let received;
  const seen = new Promise((resolve) => (received = resolve));
  let release;
  const proceed = new Promise((resolve) => (release = resolve));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received();
    await proceed;
    res.writeHead(200, { "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stateRoot = join(await fs.mkdtemp(join(fixture, "race-")), "private");
  const first = await client({ origin, stateRoot });
  const second = await client({ origin, stateRoot });
  try {
    await first.setOptIn(true);
    await first.setHistoryOptIn(true);
    const sync = first.syncHistoryPermission();
    await seen;
    await assert.rejects(second.setHistoryOptIn(false), { code: "Busy" });
    release();
    assert.equal(await sync, true);
    await second.setHistoryOptIn(false);
    assert.deepEqual(await first.historyStatus(), { decision: "declined", pending: true });
  } finally {
    release();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("invalid additional permission state fails closed", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "invalid-extra-")), "private");
  const c = await client({ stateRoot });
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  await c.setPublicUsageOptIn(true);
  const path = stateFile(stateRoot);
  const original = JSON.parse(await fs.readFile(path, "utf8"));
  for (const mutate of [
    (s) => (s.history.changedAt = 253402300800000),
    (s) => (s.publicUsage.revision = "x".repeat(65)),
    (s) => (s.optIn = false),
    (s) => (s.disabled = true),
    (s) => (s.deleting = true),
    (s) => (s.history.enabled = false),
    (s) => (s.identity = null),
  ]) {
    const value = structuredClone(original);
    mutate(value);
    await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(c.historyStatus(), { code: "State" });
  }
});

test("stale pending grants cannot sync with an active identity; old withdrawals can", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stateRoot = join(await fs.mkdtemp(join(fixture, "stale-extra-")), "private");
  const c = await client({ origin, stateRoot });
  try {
    await c.setOptIn(true);
    await c.setHistoryOptIn(true);
    await c.setPublicUsageOptIn(true);
    const path = stateFile(stateRoot, origin);
    const state = JSON.parse(await fs.readFile(path, "utf8"));
    state.identity.lastAcceptedAt = Date.now();
    state.history.changedAt = state.publicUsage.changedAt = Date.now() - 90 * 86400000;
    await fs.writeFile(path, JSON.stringify(state), { mode: 0o600 });
    assert.equal(await c.syncHistoryPermission(), false);
    assert.equal(await c.syncPublicUsagePermission(), false);
    assert.equal(calls, 0);
    await c.setHistoryOptIn(false);
    const withdrawn = JSON.parse(await fs.readFile(path, "utf8"));
    withdrawn.history.changedAt = withdrawn.publicUsage.changedAt = Date.now() - 90 * 86400000;
    await fs.writeFile(path, JSON.stringify(withdrawn), { mode: 0o600 });
    assert.equal(await c.syncHistoryPermission(), true);
    assert.equal(await c.syncPublicUsagePermission(), true);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("expired ordinary identity cannot grant or synchronize additional permissions", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "expired-extra-")), "private");
  const c = await client({ stateRoot });
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  const path = stateFile(stateRoot);
  const state = JSON.parse(await fs.readFile(path, "utf8"));
  state.identity.consentedAt = Date.now() - 90 * 86400000;
  state.identity.lastAcceptedAt = 0;
  await fs.writeFile(path, JSON.stringify(state), { mode: 0o600 });
  assert.equal(await c.syncHistoryPermission(), false);
  await assert.rejects(c.setPublicUsageOptIn(true), { code: "AdditionalPermission" });
  assert.equal(await c.requestHistoryOptIn("Settings"), "unavailable");
  await c.delete();
  assert.equal((await c.historyStatus()).decision, "declined");
});

test("concurrent refusal wins over an interactive affirmative answer", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "prompt-extra-")), "private");
  const options = {
    origin: "http://127.0.0.1:1",
    stateRoot,
    tool: "ferriki",
    version: "1.2.3",
    interaction: "terminal",
  };
  const c = await client(options);
  await c.setOptIn(true);
  const script = `Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});const {Client}=require(${JSON.stringify(installed)});new Client(${JSON.stringify(options)}).requestHistoryOptIn('Settings').then(v=>console.log(v)).catch(e=>{console.error(e);process.exitCode=1});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      child.stderr.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Allow? [y/N]")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("prompt exited early")));
    });
    await c.setHistoryOptIn(false);
    child.stdin.end("y\n");
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.match(output, /unavailable/);
    assert.equal((await c.historyStatus()).decision, "declined");
  } finally {
    child.kill();
  }
});

test("concurrent publication refusal wins over an interactive affirmative answer", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "prompt-extra-")), "private");
  const options = {
    origin: "http://127.0.0.1:1",
    stateRoot,
    tool: "ferriki",
    version: "1.2.3",
    interaction: "terminal",
  };
  const c = await client(options);
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  const script = `Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});const {Client}=require(${JSON.stringify(installed)});new Client(${JSON.stringify(options)}).requestPublicUsageOptIn('Settings').then(v=>console.log(v)).catch(e=>{console.error(e);process.exitCode=1});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      child.stderr.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Allow? [y/N]")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("prompt exited early")));
    });
    await c.setPublicUsageOptIn(false);
    child.stdin.end("y\n");
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.match(output, /unavailable/);
    assert.equal((await c.publicUsageStatus()).decision, "declined");
  } finally {
    child.kill();
  }
});

test("worker threads never prompt for additional permissions", async () => {
  const stateRoot = join(await fs.mkdtemp(join(fixture, "worker-extra-")), "private");
  const options = {
    origin: "http://127.0.0.1:1",
    stateRoot,
    tool: "ferriki",
    version: "1.2.3",
    interaction: "terminal",
  };
  const c = await client(options);
  await c.setOptIn(true);
  await c.setHistoryOptIn(true);
  const { Worker } = require("node:worker_threads");
  const script = `const {parentPort}=require('node:worker_threads');Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});const {Client}=require(${JSON.stringify(installed)});new Client(${JSON.stringify(options)}).requestHistoryOptIn('Settings').then(v=>parentPort.postMessage(v));`;
  const worker = new Worker(script, { eval: true });
  assert.equal((await once(worker, "message"))[0], "unavailable");
  await worker.terminate();
});

test("installed reminder claims before input, defers privately, and observes cooldown and decisions", async () => {
  const stateRoot = join(fixture, "reminder");
  const script = `
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    Object.defineProperty(process.stderr, 'isTTY', {value:true});
    Date.now = () => Number(process.env.TEST_NOW);
    const {Client}=require(${JSON.stringify(installed)});
    const c=new Client({origin:'http://127.0.0.1:1',stateRoot:process.env.TEST_ROOT,tool:'ferriki',version:'1.2.3',projectContext:()=>{throw Error('project accessed')}});
    c.requestOptInReminder('Purpose').then(result=>process.stdout.write(result)).catch(e=>{console.error(e);process.exitCode=1});`;
  async function run(at, answer) {
    const child = bound(
      spawn(process.execPath, ["-e", script], {
        env: { ...process.env, TEST_ROOT: stateRoot, TEST_NOW: String(at) },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    let output = "",
      prompt = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => {
      prompt += chunk;
      if (prompt.includes("default: later") && answer !== null) child.stdin.end(answer);
    });
    if (answer === null) child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 0, prompt);
    return { output, prompt };
  }
  const at = 1_000_000_000_000,
    interval = 14 * 86_400_000;
  assert.equal((await run(at, "\n")).output, "unavailable");
  const files = await fs.readdir(
    join(
      stateRoot,
      createHash("sha256").update("http://127.0.0.1:1").digest("hex"),
      "ferriki",
      "node-events-v1",
    ),
  );
  const stateFile = files.find((name) => name.endsWith(".json"));
  assert.ok(stateFile);
  const stored = JSON.parse(
    await fs.readFile(
      join(
        stateRoot,
        createHash("sha256").update("http://127.0.0.1:1").digest("hex"),
        "ferriki",
        "node-events-v1",
        stateFile,
      ),
    ),
  );
  assert.equal(stored.identity, null);
  assert.deepEqual(stored.open, {});
  assert.deepEqual(stored.batches, []);
  assert.equal(stored.job, null);
  for (const time of [at - 1, at, at + interval - 1]) {
    const result = await run(time, null);
    assert.equal(result.output, "unavailable");
    assert.equal(result.prompt, "");
  }
  assert.equal((await run(at + interval, "yes\n")).output, "granted");
  assert.equal((await run(at + 2 * interval, null)).output, "granted");
});

test("reminder interruption, concurrent claim, and refusal during the prompt remain safe", async () => {
  const stateRoot = join(fixture, "reminder-race");
  const opts = { origin: "http://127.0.0.1:1", stateRoot, tool: "ferriki", version: "1.2.3" };
  const script = `Object.defineProperty(process.stdin,'isTTY',{value:true}); Object.defineProperty(process.stderr,'isTTY',{value:true}); const {Client}=require(${JSON.stringify(installed)}); new Client(${JSON.stringify(opts)}).requestOptInReminder('Purpose').then(x=>process.stdout.write(x)).catch(e=>{console.error(e);process.exitCode=1});`;
  const launch = () =>
    bound(spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }));
  const first = launch();
  let prompt = "";
  first.stderr.on("data", (data) => (prompt += data));
  while (!prompt.includes("default: later"))
    await Promise.race([
      once(first.stderr, "data"),
      once(first, "exit").then(() => {
        throw Error("prompt process exited");
      }),
    ]);
  const second = launch();
  let result = "";
  second.stdout.on("data", (data) => (result += data));
  assert.equal((await once(second, "exit"))[0], 0);
  assert.equal(result, "unavailable");
  const c = new Client({ ...opts, interaction: "never" });
  await c.setOptIn(false);
  let firstResult = "";
  first.stdout.on("data", (data) => (firstResult += data));
  first.stdin.end("yes\n");
  assert.equal((await once(first, "exit"))[0], 0);
  assert.equal(firstResult, "declined");
  assert.equal((await c.status()).decision, "declined");

  const interruptedRoot = join(fixture, "reminder-interrupted");
  const interruptedScript = script.replace(
    JSON.stringify(stateRoot),
    JSON.stringify(interruptedRoot),
  );
  const interrupted = bound(
    spawn(process.execPath, ["-e", interruptedScript], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  let interruption = "";
  interrupted.stderr.on("data", (data) => (interruption += data));
  while (!interruption.includes("default: later"))
    await Promise.race([
      once(interrupted.stderr, "data"),
      once(interrupted, "exit").then(() => {
        throw Error("prompt process exited");
      }),
    ]);
  interrupted.stdin.end("yes");
  let interruptedResult = "";
  interrupted.stdout.on("data", (data) => (interruptedResult += data));
  assert.equal((await once(interrupted, "exit"))[0], 0);
  assert.equal(interruptedResult, "unavailable");
  assert.equal(
    (await new Client({ ...opts, stateRoot: interruptedRoot, interaction: "never" }).status())
      .decision,
    "undecided",
  );
});

test(
  "reminder choices, crashes, and restrictions preserve consent and avoid network",
  { timeout: 20000 },
  async () => {
    let requests = 0;
    const service = await server((req, res) => {
      requests++;
      res.end();
    });
    try {
      async function run(root, answer, options = {}) {
        const opts = {
          origin: service.origin,
          stateRoot: root,
          tool: "ferriki",
          version: "1.2.3",
          ...options,
        };
        const script = `Object.defineProperty(process.stdin,'isTTY',{value:true}); Object.defineProperty(process.stderr,'isTTY',{value:true}); const {Client}=require(${JSON.stringify(installed)}); const c=new Client(${JSON.stringify(opts)}); c.requestOptInReminder('Purpose').then(x=>process.stdout.write(x)).catch(e=>{console.error(e);process.exitCode=1});`;
        const child = bound(
          spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }),
        );
        let output = "",
          prompt = "";
        child.stdout.on("data", (data) => (output += data));
        child.stderr.on("data", (data) => {
          prompt += data;
          if (prompt.includes("default: later") && answer !== null) {
            if (answer === "crash") child.kill();
            else child.stdin.end(answer);
          }
        });
        if (answer === null) child.stdin.end();
        const [code, signal] = await once(child, "exit");
        if (answer === "crash") assert.ok(signal);
        else assert.equal(code, 0, prompt);
        return { output, prompt };
      }
      for (const answer of ["never\n", "no\n"]) {
        const root = join(fixture, `reminder-${answer.trim()}`);
        const first = await run(root, answer);
        assert.equal(first.output, "declined");
        assert.match(first.prompt, /Is ferriki working well for you\?/);
        assert.match(first.prompt, /sharing optional usage statistics/);
        assert.equal((await run(root, null)).output, "declined");
      }
      const withdrawal = join(fixture, "reminder-withdrawal");
      const c = new Client({
        origin: service.origin,
        stateRoot: withdrawal,
        tool: "ferriki",
        version: "1.2.3",
        interaction: "never",
      });
      await c.setOptIn(true);
      await c.setOptIn(false);
      assert.equal((await run(withdrawal, null)).output, "declined");
      const crash = join(fixture, "reminder-crash");
      await run(crash, "crash");
      assert.equal((await run(crash, null)).output, "unavailable");
      const crashed = new Client({
        origin: service.origin,
        stateRoot: crash,
        tool: "ferriki",
        version: "1.2.3",
        interaction: "never",
      });
      assert.equal((await crashed.status()).decision, "undecided");
      const crashDir = join(
        crash,
        createHash("sha256").update(service.origin).digest("hex"),
        "ferriki",
        "node-events-v1",
      );
      const crashFile = join(
        crashDir,
        (await fs.readdir(crashDir)).find((x) => x.endsWith(".json")),
      );
      assert.equal(JSON.parse(await fs.readFile(crashFile)).identity, null);
      assert.deepEqual(await crashed.preview(), { open: [], batches: [] });
      assert.equal(
        (
          await run(join(fixture, "reminder-ci"), null, {
            policy: { ci: true, isolatedCiState: true, ciRevision: "telemetry-v1" },
          })
        ).output,
        "unavailable",
      );
      assert.equal(
        (await run(join(fixture, "reminder-never-interact"), null, { interaction: "never" }))
          .output,
        "unavailable",
      );
      const deferred = join(fixture, "reminder-network");
      assert.equal((await run(deferred, "later\n")).output, "unavailable");
      const d = new Client({
        origin: service.origin,
        stateRoot: deferred,
        tool: "ferriki",
        version: "1.2.3",
        interaction: "never",
      });
      assert.equal(await d.record("language.use", dimensions), "suppressed");
      assert.equal(await d.flushInBackground(), false);
      assert.equal(requests, 0);
    } finally {
      await service.close();
    }
  },
);

test(
  "simultaneous reminder claims on existing settings show at most one prompt",
  { timeout: 15000 },
  async () => {
    const root = join(fixture, "reminder-simultaneous");
    const opts = {
      origin: "http://127.0.0.1:1",
      stateRoot: root,
      tool: "ferriki",
      version: "1.2.3",
    };
    const c = new Client({ ...opts, interaction: "never" });
    await c.setDisabled(false);
    const script = `Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});const {Client}=require(${JSON.stringify(installed)});new Client(${JSON.stringify(opts)}).requestOptInReminder('Purpose').then(x=>process.stdout.write(x)).catch(e=>{if(e.code==='Busy')process.stdout.write('Busy');else{console.error(e);process.exitCode=1}});`;
    const children = Array.from({ length: 4 }, () =>
      bound(spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] })),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        let output = "",
          prompt = "";
        child.stdout.on("data", (x) => (output += x));
        child.stderr.on("data", (x) => {
          prompt += x;
          if (prompt.includes("default: later")) child.stdin.end("later\n");
        });
        const [code] = await once(child, "exit");
        assert.equal(code, 0, prompt);
        return { output, prompt };
      }),
    );
    // Foreground reads and claims can return bounded contention. The winner
    // must still claim exactly one prompt; other errors remain test failures.
    assert.ok(results.every((x) => x.output === "unavailable" || x.output === "Busy"));
    assert.equal(results.filter((x) => x.prompt.includes("default: later")).length, 1);
    assert.equal((await c.status()).decision, "undecided");
  },
);

test("worker threads and nonterminal sessions cannot claim reminders", async () => {
  const { Worker } = require("node:worker_threads");
  const root = join(fixture, "reminder-worker");
  const options = {
    origin: "http://127.0.0.1:1",
    stateRoot: root,
    tool: "ferriki",
    version: "1.2.3",
  };
  const source = `const {parentPort}=require('node:worker_threads'); Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true}); const {Client}=require(${JSON.stringify(installed)}); new Client(${JSON.stringify(options)}).requestOptInReminder('Purpose').then(x=>parentPort.postMessage(x)).catch(e=>parentPort.postMessage('error:'+e.message));`;
  const worker = new Worker(source, { eval: true });
  assert.equal((await once(worker, "message"))[0], "unavailable");
  await worker.terminate();
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  const c = new Client(options);
  assert.equal(await c.requestOptInReminder("Purpose"), "unavailable");
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
});

test("reminder timestamp rejects values beyond the supported clock range", async () => {
  const root = join(fixture, "reminder-invalid-time");
  const options = {
    origin: "http://127.0.0.1:1",
    stateRoot: root,
    tool: "ferriki",
    version: "1.2.3",
    interaction: "never",
  };
  const c = new Client(options);
  await c.setDisabled(false);
  const dir = join(
    root,
    createHash("sha256").update(options.origin).digest("hex"),
    "ferriki",
    "node-events-v1",
  );
  const file = join(
    dir,
    (await fs.readdir(dir)).find((x) => x.endsWith(".json")),
  );
  const state = JSON.parse(await fs.readFile(file));
  state.lastPermissionPromptAt = 253_402_300_800_000;
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(c.requestOptInReminder("Purpose"), { code: "State" });
});

test("v2 profile shares one file across Rust and installed Node with separate choices", async () => {
  const root = resolve(__dirname, "../../..");
  execFileSync("cargo", ["build", "--locked", "--example", "unified-client-fixture"], {
    cwd: root,
    stdio: "pipe",
  });
  const binary = join(
    root,
    "target",
    "debug",
    "examples",
    `unified-client-fixture${process.platform === "win32" ? ".exe" : ""}`,
  );
  const origin = "http://127.0.0.1:1";
  for (const rustFirst of [true, false]) {
    const dir = await fs.mkdtemp(join(fixture, "profile-"));
    const shared = join(dir, "shared");
    const node = await client({ stateRoot: join(dir, "node"), sharedProfileRoot: shared, origin });
    const env = {
      ...process.env,
      APP_TRACKING_FIXTURE_ORIGIN: origin,
      APP_TRACKING_FIXTURE_ROOT: join(dir, "rust"),
      APP_TRACKING_FIXTURE_SHARED: shared,
    };
    const rust = (op) => execFileSync(binary, [op], { cwd: root, env, encoding: "utf8" });
    await node.setOptIn(true);
    assert.equal((await node.profileStatus()).decision, "undecided");
    if (rustFirst) rust("profile-enable");
    else await node.setProfileLinking(true);
    const file = join(
      shared,
      "profiles-v2",
      createHash("sha256").update(origin).digest("hex"),
      "profile.json",
    );
    const first = JSON.parse(await fs.readFile(file, "utf8"));
    assert.notEqual(first.profile_id, first.token);
    if (rustFirst) await node.setProfileLinking(true);
    else rust("profile-enable");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), first);
    assert.equal((await node.profileStatus()).decision, "granted");
    assert.match(rust("profile-status"), /Granted/);
    const nodeState = JSON.parse(
      await fs.readFile(
        resolve(
          dir,
          "node",
          createHash("sha256").update(origin).digest("hex"),
          "ferriki",
          "node-events-v1",
          "state.json",
        ),
        "utf8",
      ),
    );
    assert.equal(nodeState.schemaVersion, 2);
    assert.notEqual(nodeState.identity.id, first.profile_id);
    assert.notEqual(nodeState.identity.token, first.token);
    rust("profile-reset");
    assert.equal(await node.profileResetPending(), true);
    assert.equal(await node.syncProfileReset(), false);
    assert.equal((await node.profileStatus()).decision, "undecided");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).profile_id, first.profile_id);
  }
});

test("v2 profile lock fails closed until explicit recovery after all processes stop", async () => {
  const root = await fs.mkdtemp(join(fixture, "profile-lock-"));
  const shared = join(root, "shared");
  const origin = "http://127.0.0.1:1";
  const c = await client({ stateRoot: join(root, "state"), sharedProfileRoot: shared, origin });
  await c.setOptIn(true);
  await c.setProfileLinking(true);
  const dir = join(shared, "profiles-v2", createHash("sha256").update(origin).digest("hex"));
  await fs.mkdir(join(dir, "profile.lock"));
  await assert.rejects(c.profileStatus(), { code: "Busy" });
  await fs.rmdir(join(dir, "profile.lock"));
  assert.equal((await c.profileStatus()).decision, "granted");
});

test("profile sync requires exact acknowledgements and never rotates on missing or wrong reset", async () => {
  let mode = "mismatch";
  let seen = [];
  const s = await server(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ path: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (mode === "unauthorized") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "unauthorized" } }));
      return;
    }
    if (req.method === "PUT") {
      const value = JSON.parse(body);
      delete value.profile_token;
      if (mode === "mismatch") value.profile_id = "0".repeat(64);
      res.end(JSON.stringify(value));
    } else if (mode === "missing") {
      res.statusCode = 404;
      res.end(JSON.stringify({ schema_version: 1, error: { code: "installation_not_found" } }));
    } else {
      const id = req.url.split("/").pop();
      res.end(
        JSON.stringify({
          schema_version: 1,
          revision: "profile-linking-v1",
          profile_id: mode === "mismatch" ? "0".repeat(64) : id,
          status: "deleted",
        }),
      );
    }
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "profile-sync-"));
    const c = await client({
      origin: s.origin,
      stateRoot: join(root, "state"),
      sharedProfileRoot: join(root, "shared"),
    });
    await assert.rejects(c.setProfileLinking(true), { code: "AdditionalPermission" });
    await c.setOptIn(true);
    await c.setProfileLinking(true);
    assert.equal((await c.profileStatus()).pending, true);
    assert.equal(await c.syncProfileLinking(), false);
    mode = "ok";
    assert.equal(await c.syncProfileLinking(), true);
    assert.notEqual(seen[0].auth, `Bearer ${seen[0].body.profile_token}`);
    const previous = seen[0].body.profile_id;
    await c.requestProfileReset();
    mode = "missing";
    assert.equal(await c.syncProfileReset(), false);
    mode = "mismatch";
    assert.equal(await c.syncProfileReset(), false);
    mode = "unauthorized";
    assert.equal(await c.syncProfileReset(), false);
    assert.equal(await c.profileResetPending(), true);
    mode = "ok";
    assert.equal(await c.syncProfileReset(), true);
    assert.equal((await c.profileStatus()).decision, "undecided");
    const shared = join(
      root,
      "shared",
      "profiles-v2",
      createHash("sha256").update(s.origin).digest("hex"),
      "profile.json",
    );
    assert.notEqual(JSON.parse(await fs.readFile(shared, "utf8")).profile_id, previous);
  } finally {
    await s.close();
  }
});

test("Rust and Node contend on the same v2 lock in both runtime orders", async () => {
  const repo = resolve(__dirname, "../../..");
  const binary = join(
    repo,
    "target",
    "debug",
    "examples",
    `unified-client-fixture${process.platform === "win32" ? ".exe" : ""}`,
  );
  for (const rustFirst of [false, true]) {
    let arrive;
    const arrived = new Promise((resolve) => {
      arrive = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const s = await server(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      arrive();
      await gate;
      const value = JSON.parse(body);
      delete value.profile_token;
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "profile-contention-"));
      const shared = join(root, "shared");
      const c = await client({
        origin: s.origin,
        stateRoot: join(root, "node"),
        sharedProfileRoot: shared,
      });
      const env = {
        ...process.env,
        APP_TRACKING_FIXTURE_ORIGIN: s.origin,
        APP_TRACKING_FIXTURE_ROOT: join(root, "rust"),
        APP_TRACKING_FIXTURE_SHARED: shared,
      };
      const run = (op) => execFileSync(binary, [op], { cwd: repo, env, encoding: "utf8" });
      await c.setOptIn(true);
      await c.setProfileLinking(true);
      run("profile-enable");
      if (rustFirst) {
        const child = bound(spawn(binary, ["profile-sync"], { cwd: repo, env, stdio: "ignore" }));
        await arrived;
        await assert.rejects(c.profileStatus(), { code: "Busy" });
        await assert.rejects(c.requestProfileReset(), { code: "Busy" });
        release();
        const [code] = await once(child, "exit");
        assert.equal(code, 0);
      } else {
        const syncing = c.syncProfileLinking();
        await arrived;
        assert.throws(() => run("profile-status"));
        assert.throws(() => run("profile-reset"));
        release();
        assert.equal(await syncing, true);
      }
    } finally {
      release();
      await s.close();
    }
  }
});

test("a delayed first link cannot make a missing-profile reset rotate", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  let lateApplied = false;
  const s = await server(async (req, res) => {
    if (req.method === "PUT") {
      let data = "";
      for await (const part of req) data += part;
      arrived();
      await gate;
      lateApplied = true;
      const body = JSON.parse(data);
      delete body.profile_token;
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    } else {
      res.statusCode = 404;
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ schema_version: 1, error: { code: "installation_not_found" } }));
    }
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "profile-late-"));
    const c = await client({
      origin: s.origin,
      stateRoot: join(root, "state"),
      sharedProfileRoot: join(root, "shared"),
    });
    await c.setOptIn(true);
    await c.setProfileLinking(true);
    const file = join(
      root,
      "shared",
      "profiles-v2",
      createHash("sha256").update(s.origin).digest("hex"),
      "profile.json",
    );
    const id = JSON.parse(await fs.readFile(file, "utf8")).profile_id;
    const pending = c.syncProfileLinking();
    await waiting;
    assert.equal(await pending, false);
    await c.requestProfileReset();
    assert.equal(await c.syncProfileReset(), false);
    release();
    await eventually(async () => lateApplied);
    const after = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(after.profile_id, id);
    assert.equal(after.reset_pending, true);
    assert.equal((await c.profileStatus()).decision, "undecided");
    assert.equal(await c.syncProfileLinking(), false);
  } finally {
    release();
    await s.close();
  }
});

test("simultaneous Rust and Node creation converges or reports retryable contention", async () => {
  const repo = resolve(__dirname, "../../..");
  const binary = join(
    repo,
    "target",
    "debug",
    "examples",
    `unified-client-fixture${process.platform === "win32" ? ".exe" : ""}`,
  );
  const root = await fs.mkdtemp(join(fixture, "profile-race-"));
  const origin = "http://127.0.0.1:1";
  const shared = join(root, "shared");
  const c = await client({ origin, stateRoot: join(root, "node"), sharedProfileRoot: shared });
  await c.setOptIn(true);
  const env = {
    ...process.env,
    APP_TRACKING_FIXTURE_ORIGIN: origin,
    APP_TRACKING_FIXTURE_ROOT: join(root, "rust"),
    APP_TRACKING_FIXTURE_SHARED: shared,
  };
  const child = bound(spawn(binary, ["profile-enable"], { cwd: repo, env, stdio: "pipe" }));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const attempt = c.setProfileLinking(true).then(
    () => "ok",
    (error) => error.code,
  );
  const [code] = await once(child, "close");
  const nodeResult = await attempt;
  assert.ok(nodeResult === "ok" || nodeResult === "Busy");
  assert.ok(
    code === 0 || (code === 1 && /^Error: Busy\s*$/.test(stderr)),
    `unexpected Rust failure: ${stderr}`,
  );
  if (nodeResult === "Busy") await c.setProfileLinking(true);
  if (code !== 0) execFileSync(binary, ["profile-enable"], { cwd: repo, env, stdio: "pipe" });
  assert.equal((await c.profileStatus()).decision, "granted");
  assert.match(
    execFileSync(binary, ["profile-status"], { cwd: repo, env, encoding: "utf8" }),
    /Granted/,
  );
});

test("a never-registered profile remains pending while offline", async () => {
  const root = await fs.mkdtemp(join(fixture, "profile-offline-reset-"));
  const c = await client({
    stateRoot: join(root, "state"),
    sharedProfileRoot: join(root, "shared"),
    policy: { offline: true },
  });
  await c.setOptIn(true);
  await c.setProfileLinking(true);
  await c.requestProfileReset();
  assert.equal(await c.syncProfileReset(), false);
  assert.equal((await c.profileStatus()).decision, "undecided");
  assert.equal(await c.profileResetPending(), true);
});

test("a killed Rust holder leaves the v2 lock busy until explicit recovery", async () => {
  const repo = resolve(__dirname, "../../..");
  const binary = join(
    repo,
    "target",
    "debug",
    "examples",
    `unified-client-fixture${process.platform === "win32" ? ".exe" : ""}`,
  );
  let arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const s = await server(async (req, res) => {
    for await (const _ of req) {
      /* consume request */
    }
    arrived();
    await gate;
    res.setHeader("Cache-Control", "no-store");
    res.end("{}");
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "profile-crash-"));
    const shared = join(root, "shared");
    const c = await client({
      origin: s.origin,
      stateRoot: join(root, "node"),
      sharedProfileRoot: shared,
    });
    const env = {
      ...process.env,
      APP_TRACKING_FIXTURE_ORIGIN: s.origin,
      APP_TRACKING_FIXTURE_ROOT: join(root, "rust"),
      APP_TRACKING_FIXTURE_SHARED: shared,
    };
    await c.setOptIn(true);
    await c.setProfileLinking(true);
    execFileSync(binary, ["profile-enable"], { cwd: repo, env, stdio: "pipe" });
    const child = bound(spawn(binary, ["profile-sync"], { cwd: repo, env, stdio: "ignore" }));
    await waiting;
    const exit = once(child, "exit");
    child.kill();
    await exit;
    await assert.rejects(c.profileStatus(), { code: "Busy" });
    const lock = join(
      shared,
      "profiles-v2",
      createHash("sha256").update(s.origin).digest("hex"),
      "profile.lock",
    );
    await fs.rmdir(lock);
    assert.equal((await c.profileStatus()).decision, "granted");
  } finally {
    release();
    await s.close();
  }
});

test("profile refusal persists and ordinary withdrawal queues an unlink", async () => {
  const root = await fs.mkdtemp(join(fixture, "profile-withdrawal-"));
  const shared = join(root, "shared");
  const c = await client({
    stateRoot: join(root, "state"),
    sharedProfileRoot: shared,
    policy: { offline: true },
  });
  await c.setOptIn(true);
  await c.setProfileLinking(false);
  assert.equal(await c.requestProfileLinking("Explain linking"), "declined");
  await assert.rejects(fs.access(shared), { code: "ENOENT" });
  await c.setProfileLinking(true);
  await c.setOptIn(false);
  assert.deepEqual(await c.profileStatus(), {
    decision: "declined",
    pending: true,
    resetPending: false,
  });
  assert.equal(await c.syncProfileLinking(), false);
  assert.equal((await c.status()).optIn, false);
});

test("a stale copied profile cannot claim a reset after another copy links", async () => {
  const s = await server(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const receipt = JSON.parse(body);
    delete receipt.profile_token;
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(receipt));
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "profile-copy-reset-"));
    const originalRoot = join(root, "original"),
      copyRoot = join(root, "copy");
    const original = await client({
      origin: s.origin,
      stateRoot: join(root, "one"),
      sharedProfileRoot: originalRoot,
    });
    const copy = await client({
      origin: s.origin,
      stateRoot: join(root, "two"),
      sharedProfileRoot: copyRoot,
      policy: { offline: true },
    });
    await original.setOptIn(true);
    await original.setProfileLinking(true);
    await fs.cp(originalRoot, copyRoot, { recursive: true });
    const file = join(
      copyRoot,
      "profiles-v2",
      createHash("sha256").update(s.origin).digest("hex"),
      "profile.json",
    );
    const before = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(await original.syncProfileLinking(), true);
    await copy.requestProfileReset();
    assert.equal(await copy.syncProfileReset(), false);
    const after = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(after.profile_id, before.profile_id);
    assert.equal(after.token, before.token);
    assert.equal(after.reset_pending, true);
  } finally {
    await s.close();
  }
});

test("profile missing files, stale choices, CI, and noninteractive modes fail closed", async () => {
  let requests = 0;
  const s = await server(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests++;
    const value = JSON.parse(body);
    delete value.profile_token;
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "profile-negatives-"));
    const stateRoot = join(root, "state"),
      shared = join(root, "shared");
    const c = await client({ origin: s.origin, stateRoot, sharedProfileRoot: shared });
    await c.setOptIn(true);
    assert.equal(await c.requestProfileLinking("Explain linking"), "unavailable");
    await c.setProfileLinking(true);
    const hash = createHash("sha256").update(s.origin).digest("hex");
    const state = join(stateRoot, hash, "ferriki", "node-events-v1", "state.json");
    const profile = join(shared, "profiles-v2", hash, "profile.json");
    let saved = JSON.parse(await fs.readFile(state, "utf8"));
    saved.profile.revision = "unknown";
    await fs.writeFile(state, JSON.stringify(saved));
    assert.equal(await c.syncProfileLinking(), false);
    assert.equal((await c.profileStatus()).decision, "undecided");
    await c.setProfileLinking(true);
    saved = JSON.parse(await fs.readFile(state, "utf8"));
    saved.profile.changedAt = Date.now() - 91 * 86400000;
    await fs.writeFile(state, JSON.stringify(saved));
    assert.equal(await c.syncProfileLinking(), false);
    await c.setProfileLinking(true);
    await fs.rm(profile);
    assert.equal(await c.syncProfileLinking(), false);
    assert.equal((await c.profileStatus()).decision, "undecided");
    assert.equal(requests, 0);
    const ciRoot = join(root, "ci-shared");
    const ci = await client({
      origin: s.origin,
      stateRoot: join(root, "ci"),
      sharedProfileRoot: ciRoot,
      policy: { ci: true, isolatedCiState: true, ciRevision: "telemetry-v1" },
    });
    assert.equal(await ci.requestProfileLinking("Explain linking"), "unavailable");
    await assert.rejects(ci.setProfileLinking(true), { code: "AdditionalPermission" });
    await assert.rejects(fs.access(ciRoot), { code: "ENOENT" });
  } finally {
    await s.close();
  }
});

test("the shipped Ardo catalog gates and validates the shared invocation scenarios", async () => {
  const scenarios = JSON.parse(
    await fs.readFile(resolve(__dirname, "../../../contracts/ardo-invocations.json"), "utf8"),
  );
  const c = await client({ tool: scenarios.tool, version: scenarios.version });
  assert.equal(
    await c.record(scenarios.metric, () => {
      throw new Error("Must not collect before consent");
    }),
    "suppressed",
  );
  assert.deepEqual(await c.preview(), { open: [], batches: [] });
  await c.setOptIn(true);
  for (const command of scenarios.commands)
    assert.equal(await c.record(scenarios.metric, { command }), "counted");
  for (const command of scenarios.invalid_commands)
    await assert.rejects(c.record(scenarios.metric, { command }), { code: "Configuration" });
  await assert.rejects(c.record(scenarios.metric, { command: "build", site: "private" }), {
    code: "Configuration",
  });
  const preview = await c.preview();
  assert.deepEqual(
    preview.open.map((row) => row.dimensions.command).sort(),
    [...scenarios.commands].sort(),
  );
  assert.ok(preview.open.every((row) => row.count === 1 && row.collection === "opt_in"));
  await c.setOptIn(false);
  assert.equal(await c.record(scenarios.metric, { command: "build" }), "suppressed");
});

const updateContract = require("../../../contracts/update-client.json");
const settingsContract = require("../../../contracts/cli-settings.json");
function updateOptions(origin, cacheRoot, extra = {}) {
  return { origin, cacheRoot, tool: "ardo", version: "1.0.0", distribution: "github", ...extra };
}
function cliOptions(origin, stateRoot, extra = {}) {
  return {
    origin,
    stateRoot,
    tool: "ardo",
    version: "1.0.0",
    interaction: "never",
    invocation: {
      metric: "cli.invocation",
      categories: { build: { command: "build" }, dev: { command: "dev" } },
    },
    ...extra,
  };
}
function updatePath(root) {
  return join(root, "node-updates-v1", "ardo.github.stable.json");
}
async function writeUpdateState(root, origin, extra = {}) {
  await fs.mkdir(join(root, "node-updates-v1"), { recursive: true, mode: 0o700 });
  const state = {
    schema_version: 1,
    resource: `${origin}/v1/versions/ardo/github/stable`,
    next_check: 0,
    failures: 0,
    release: null,
    etag: null,
    noticed_version: null,
    noticed_at: 0,
    ...extra,
  };
  await fs.writeFile(updatePath(root), JSON.stringify(state), { mode: 0o600 });
}
async function updateClock(at, fn) {
  const original = Date.now;
  Date.now = () => at * 1000;
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}
function freshRelease() {
  return { ...updateContract.release, checked_at: new Date().toISOString() };
}
async function installedProcess(code, args = []) {
  const child = bound(
    spawn(process.execPath, ["-e", code, installed, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const [status, signal] = await once(child, "exit");
  return { status, signal, stdout, stderr };
}

test("update construction is passive in CJS and ESM; disabled/offline never create state", async () => {
  const root = join(fixture, "passive-updates");
  const esm = await import(pathToFileURL(join(installed, "dist/index.mjs")).href);
  assert.equal(typeof esm.UpdateClient, "function");
  assert.equal(typeof esm.CliClient, "function");
  assert.equal(esm.UPDATE_NETWORK_BUDGET_MS, 200);
  for (const c of updateContract.origins) {
    const construct = () => new UpdateClient(updateOptions(c.value, root));
    if (c.valid) construct();
    else assert.throws(construct, { code: "Configuration" }, c.value);
  }
  for (const C of [UpdateClient, esm.UpdateClient]) {
    const updates = new C(updateOptions("http://127.0.0.1:1", root));
    assert.equal(await updates.check("disabled"), undefined);
    assert.equal(await updates.check("offline"), undefined);
  }
  new CliClient(cliOptions("http://127.0.0.1:1", join(root, "reporting")));
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  for (const version of updateContract.invalid_versions)
    assert.throws(() => new UpdateClient(updateOptions("https://example.com", root, { version })), {
      code: "Configuration",
    });
  for (const origin of [
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com/path",
    "https://example.com?secret=1",
    "https://example.com#x",
  ])
    assert.throws(() => new UpdateClient(updateOptions(origin, root)), { code: "Configuration" });
});

test("shared Rust/Node fixtures cover SemVer, response validation, backoff, and notices", async () => {
  const logic = await import(
    pathToFileURL(resolve(__dirname, "../../../dist/node-client-test/update-contract.mjs")).href
  );
  for (const c of updateContract.precedence)
    assert.equal(
      logic.compare(logic.version(c.latest), logic.version(c.installed)) > 0,
      c.greater,
      JSON.stringify(c),
    );
  for (const v of updateContract.invalid_versions) assert.equal(logic.version(v), undefined, v);
  const options = updateOptions("https://example.com", "/unused");
  for (const c of updateContract.validation) {
    const r = { ...updateContract.release, ...c.patch };
    const now = updateContract.now + c.offset;
    if (!c.valid)
      assert.throws(
        () => logic.release(r, options, now),
        { code: "InvalidResponse" },
        JSON.stringify(c),
      );
    else {
      logic.release(r, options, now);
      if (c.fresh) logic.freshResponse(r, now);
      else assert.throws(() => logic.freshResponse(r, now), { code: "InvalidResponse" });
    }
  }
  const state = logic.empty("https://example.com");
  for (const delay of updateContract.backoff_seconds) {
    logic.defer(state, updateContract.now);
    assert.equal(state.next_check, updateContract.now + delay);
  }
  for (const c of updateContract.notices) {
    Object.assign(state, {
      release: { ...updateContract.release, latest_version: c.latest },
      noticed_version: c.noticed,
      noticed_at: updateContract.now,
    });
    const notice = logic.notice(state, options, updateContract.now + c.offset);
    assert.equal(!!notice, c.offer, JSON.stringify(c));
    if (notice) assert.equal(notice.stale, c.stale);
  }
});

test("the packed CLI example handles help, settings, independent updates, and completion", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    assert.equal(req.headers.dnt, "1");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "packed-example-"));
    const state = join(root, "reporting"),
      cache = join(root, "updates");
    for (const command of ["help", "status", "preview", "withdraw", "build"]) {
      const child = bound(
        spawn(
          process.execPath,
          [join(installed, "examples/cli.mjs"), s.origin, state, cache, command],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      const [code] = await once(child, "exit");
      assert.equal(code, command === "build" ? 7 : 0, stderr);
      if (command === "build") {
        assert.equal(stdout, '{"command":"ok"}\n');
        assert.match(stderr, /^Update 1\.2\.3;/);
      }
      if (["help", "status", "preview"].includes(command))
        await assert.rejects(fs.stat(state), { code: "ENOENT" });
    }
    assert.equal(calls, 1);
    const cli = new CliClient(cliOptions(s.origin, state));
    assert.equal((await cli.status()).reporting.decision, "declined");
    assert.deepEqual(await cli.preview(), { open: [], batches: [] });
  } finally {
    await s.close();
  }
});

test("installed update client applies local precedence and hourly successful-check suppression", async () => {
  for (const c of updateContract.precedence.filter((c) => !c.latest.includes("-"))) {
    let calls = 0;
    const s = await server((req, res) => {
      calls++;
      assert.equal(req.url, "/v1/versions/ardo/github/stable");
      assert.equal(req.headers["user-agent"], "app-tracking-update-client");
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      assert.ok(!JSON.stringify(req.headers).includes(c.installed));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...freshRelease(), latest_version: c.latest }));
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "semver-"));
      const updates = new UpdateClient(updateOptions(s.origin, root, { version: c.installed }));
      assert.equal(!!(await updates.check("enabled")), c.greater);
      assert.equal(await updates.check("enabled"), undefined);
      assert.equal(calls, 1);
      const state = JSON.parse(await fs.readFile(updatePath(root), "utf8"));
      assert.equal(state.failures, 0);
      assert.ok(state.next_check >= Math.floor(Date.now() / 1000) + 3599);
      assert.ok(!/installation|project_id|consent|token|batches|usage/.test(JSON.stringify(state)));
      if (process.platform !== "win32")
        assert.equal((await fs.stat(updatePath(root))).mode & 0o777, 0o600);
    } finally {
      await s.close();
    }
  }
});

test("shared conditional-response cases preserve opaque ETags and original checked_at", async () => {
  for (const c of updateContract.conditional) {
    let headers;
    const s = await server((req, res) => {
      headers = req.headers;
      if (c.response_etag) res.setHeader("ETag", c.response_etag);
      res.writeHead(304).end();
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "conditional-"));
      await writeUpdateState(root, s.origin, {
        release: c.cached ? updateContract.release : null,
        etag: c.etag,
      });
      const updates = new UpdateClient(updateOptions(s.origin, root, { version: "1.2.3" }));
      await updateClock(updateContract.now + c.offset, async () => {
        if (c.accepted) assert.equal(await updates.check("enabled"), undefined);
        else await assert.rejects(updates.check("enabled"), { code: "InvalidResponse" });
      });
      assert.equal(headers["if-none-match"] ?? null, c.sent);
      if (c.accepted) {
        const state = JSON.parse(await fs.readFile(updatePath(root), "utf8"));
        assert.equal(state.etag, c.response_etag ?? c.etag);
        assert.equal(state.release.checked_at, updateContract.release.checked_at);
      }
    } finally {
      await s.close();
    }
  }
});

test("stale responses and failed attempts persist the shared backoff without retries", async () => {
  let calls = 0,
    stale = false;
  const s = await server((req, res) => {
    calls++;
    if (!stale) res.writeHead(503).end("not JSON");
    else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...updateContract.release, stale: true }));
    }
  });
  const root = await fs.mkdtemp(join(fixture, "backoff-"));
  const updates = new UpdateClient(updateOptions(s.origin, root));
  try {
    let at = updateContract.now;
    for (const [i, delay] of updateContract.backoff_seconds.entries()) {
      await updateClock(at, async () => {
        if (stale) await updates.check("enabled");
        else await assert.rejects(updates.check("enabled"), { code: "HttpStatus", status: 503 });
        assert.equal(await updates.check("enabled"), undefined);
      });
      const state = JSON.parse(await fs.readFile(updatePath(root), "utf8"));
      assert.equal(state.next_check, at + delay);
      assert.equal(calls, i + 1);
      at += delay;
      stale = true;
    }
  } finally {
    await s.close();
  }
});

test("redirects, oversized headers/bodies, non-JSON, invalid timestamps, and bare 304 fail closed", async () => {
  for (const kind of ["redirect", "headers", "body", "html", "timestamp", "304"]) {
    let calls = 0;
    const s = await server((req, res) => {
      calls++;
      if (kind === "redirect") return res.writeHead(302, { Location: "/followed" }).end();
      if (kind === "headers") res.setHeader("x-oversized", "x".repeat(16_385));
      if (kind === "304") return res.writeHead(304).end();
      res.setHeader("content-type", kind === "html" ? "text/html" : "application/json");
      res.end(
        kind === "body"
          ? "x".repeat(16_385)
          : JSON.stringify({
              ...freshRelease(),
              ...(kind === "timestamp" ? { checked_at: "invalid" } : {}),
            }),
      );
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "invalid-"));
      const updates = new UpdateClient(updateOptions(s.origin, root));
      await assert.rejects(
        updates.check("enabled"),
        (e) => e instanceof UpdateError && !e.message.includes(s.origin),
      );
      assert.equal(await updates.check("enabled"), undefined);
      assert.equal(calls, 1, kind);
    } finally {
      await s.close();
    }
  }
});

test("corrupt, unknown-schema, oversized caches and incomplete temporary files recover", async () => {
  const s = await server((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  try {
    for (const bytes of ["{", "null", '{"schema_version":999}', "x".repeat(65_537)]) {
      const root = await fs.mkdtemp(join(fixture, "corrupt-update-"));
      await writeUpdateState(root, s.origin);
      await fs.writeFile(updatePath(root), bytes, { mode: 0o600 });
      await fs.writeFile(`${updatePath(root)}.interrupted.tmp`, "{private partial", {
        mode: 0o600,
      });
      assert.ok(await new UpdateClient(updateOptions(s.origin, root)).check("enabled"));
      assert.equal(JSON.parse(await fs.readFile(updatePath(root), "utf8")).schema_version, 1);
    }
  } finally {
    await s.close();
  }
});

test("stalled headers/body use the 200 ms total network budget and retain only the claim", async () => {
  for (const body of [false, true]) {
    let calls = 0;
    const s = await server((req, res) => {
      calls++;
      if (body) {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "999" });
        res.write("{");
      }
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "deadline-"));
      const updates = new UpdateClient(updateOptions(s.origin, root));
      const start = performance.now();
      await assert.rejects(updates.check("enabled"), { code: "Network" });
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 150 && elapsed < 1500, `${elapsed}ms`);
      const state = JSON.parse(await fs.readFile(updatePath(root), "utf8"));
      assert.equal(state.failures, 1);
      assert.equal(state.release, null);
      assert.equal(await updates.check("enabled"), undefined);
      assert.equal(calls, 1);
    } finally {
      await s.close();
    }
  }
});

test("cancellation settles sockets and leaves no later requests or cache writes", async () => {
  for (const body of [false, true]) {
    const cancellation = new AbortController();
    let calls = 0,
      closed = false;
    const s = await server((req, res) => {
      calls++;
      res.once("close", () => {
        closed = true;
      });
      if (body) {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "999" });
        res.write("{");
      }
      cancellation.abort();
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "cancel-update-"));
      const updates = new UpdateClient(updateOptions(s.origin, root));
      await assert.rejects(updates.check("enabled", { signal: cancellation.signal }), {
        code: "Cancelled",
      });
      const bytes = await fs.readFile(updatePath(root), "utf8");
      const stamp = (await fs.stat(updatePath(root))).mtimeMs;
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(calls, 1);
      assert.equal(closed, true);
      assert.equal(await fs.readFile(updatePath(root), "utf8"), bytes);
      assert.equal((await fs.stat(updatePath(root))).mtimeMs, stamp);
      assert.deepEqual(
        (await fs.readdir(join(root, "node-updates-v1"))).filter(
          (p) => p.endsWith(".tmp") || p.endsWith(".lock"),
        ),
        [],
      );
      const absent = join(root, "already-cancelled");
      await assert.rejects(
        new UpdateClient(updateOptions(s.origin, absent)).check("enabled", {
          signal: cancellation.signal,
        }),
        { code: "Cancelled" },
      );
      await assert.rejects(fs.stat(absent), { code: "ENOENT" });
    } finally {
      await s.close();
    }
  }
});

test("concurrent installed processes share one update request and one offered notice", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "update-race-"));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        installedProcess(
          `const {UpdateClient}=require(process.argv[1]); new UpdateClient(${JSON.stringify(updateOptions(s.origin, root))}).check('enabled').then(u=>{if(u)process.stdout.write('notice')}).catch(e=>{process.stderr.write(e.code);process.exitCode=1});`,
        ),
      ),
    );
    assert.ok(
      results.every((r) => r.status === 0),
      JSON.stringify(results),
    );
    assert.equal(calls, 1);
    assert.equal(results.filter((r) => r.stdout === "notice").length, 1);
  } finally {
    await s.close();
  }
});

test("killing an installed writer leaves an uncommitted file that is never read", async () => {
  let calls = 0;
  const s = await server((req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "interrupted-update-"));
    const code = `const fs=require('node:fs/promises'); fs.rename=async()=>{process.send('before-commit');await new Promise(()=>{});}; setInterval(()=>{},1000); const {UpdateClient}=require(process.argv[1]); new UpdateClient(${JSON.stringify(updateOptions(s.origin, root))}).check('enabled').catch(e=>{process.send(e.code)});`;
    const child = bound(
      spawn(process.execPath, ["-e", code, installed], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    const [message] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("writer exited before reaching the commit boundary");
      }),
    ]);
    assert.equal(message, "before-commit");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(updatePath(root)), { code: "ENOENT" });
    assert.ok((await fs.readdir(join(root, "node-updates-v1"))).some((p) => p.endsWith(".tmp")));
    // Simulate lease expiry without making this suite wait 30 seconds.
    const expired = new Date(Date.now() - 60_000);
    await fs.utimes(`${updatePath(root)}.lock`, expired, expired);
    assert.ok(await new UpdateClient(updateOptions(s.origin, root)).check("enabled"));
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});

test("shared CLI settings scenarios preserve Rust decisions and privacy boundaries", async () => {
  for (const c of settingsContract.scenarios) {
    const root = join(await fs.mkdtemp(join(fixture, "cli-settings-")), "private");
    const cli = new CliClient(cliOptions("http://127.0.0.1:1", root, { policy: c.policy }));
    for (const action of c.actions) {
      if (action === "enable") await cli.enableReporting({ consent: "informed" });
      else if (action === "record") await cli.recordInvocation("build");
      else if (action === "withdraw") await cli.withdrawReporting();
      else if (action === "disable") await cli.disableReporting();
      else if (action === "delete") {
        const deletion = await cli.deleteReporting();
        assert.equal(deletion.deletion, c.pending ? "pending" : "noIdentity");
        assert.equal(deletion.handedOff, false);
      }
    }
    const status = await cli.status();
    assert.equal(status.reporting.decision, c.decision, c.name);
    assert.equal(status.reporting.collectOptIn, c.collect, c.name);
    assert.equal(status.reporting.disabled, c.disabled, c.name);
    assert.equal(status.reporting.deletionPending, c.pending, c.name);
    assert.equal((await cli.preview()).open.length, c.rows, c.name);
    assert.ok(!JSON.stringify(await cli.preview()).includes("token"));
    assert.equal(status.history.decision, "undecided");
    assert.equal(status.publicUsage.decision, "undecided");
    assert.equal(status.profile.decision, "undecided");
  }
});

test("CLI counts only the explicit invocation boundary, once across wrappers/watch calls", async () => {
  let projectCalls = 0;
  const root = join(fixture, "cli-dedup-private");
  const cli = new CliClient(
    cliOptions("http://127.0.0.1:1", root, {
      policy: { offline: true },
      projectContext: () => {
        projectCalls++;
        return { origin: null };
      },
    }),
  );
  assert.equal((await cli.status()).reporting.decision, "undecided");
  assert.equal(projectCalls, 0);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  await assert.rejects(cli.enableReporting(), { code: "Configuration" });
  await cli.enableReporting({ consent: "informed" });
  assert.deepEqual(await cli.preview(), { open: [], batches: [] }); // settings/help/version count nothing
  const first = cli.recordInvocation("build"),
    duplicate = cli.recordInvocation("dev");
  assert.deepEqual(await first, { ok: true, value: "counted" });
  assert.deepEqual(await duplicate, { ok: true, value: "alreadyRecorded" });
  assert.equal((await cli.preview()).open[0].count, 1);
  assert.equal(projectCalls, 1);
  const completion = cli.complete();
  assert.equal(cli.complete(), completion);
  assert.deepEqual(await completion, { reporting: { ok: true, value: false } });
  assert.deepEqual(await cli.recordInvocation("build"), { ok: true, value: "completed" });
});

test("CLI deletion reports pending until an authenticated worker acknowledgement", async () => {
  let deleted = false;
  const s = await server((req, res) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.headers.authorization, /^Bearer [a-f0-9]{64}$/);
    assert.equal(req.headers["app-tracking-tool"], "ardo");
    deleted = true;
    res.setHeader("cache-control", "no-store");
    res.writeHead(204).end();
  });
  try {
    const root = await fs.mkdtemp(join(fixture, "cli-deletion-"));
    const cli = new CliClient(cliOptions(s.origin, root));
    await cli.enableReporting({ consent: "informed" });
    const deletion = await cli.deleteReporting();
    assert.equal(deletion.deletion, "pending");
    assert.equal(deletion.handedOff, true);
    await eventually(async () => deleted && !(await cli.status()).reporting.deletionPending);
    const status = await cli.status();
    assert.equal(status.reporting.disabled, true);
    assert.equal(status.reporting.collectOptIn, false);
  } finally {
    await s.close();
  }
});

test("CLI completion cancels and joins updates on successful, failed, and interrupted commands", async () => {
  for (const outcome of ["success", "failure", "interrupted"]) {
    let entered;
    const arrived = new Promise((r) => {
      entered = r;
    });
    const s = await server((req, res) => {
      entered();
    });
    try {
      const root = await fs.mkdtemp(join(fixture, "cli-completion-"));
      const cli = new CliClient(
        cliOptions(s.origin, join(root, "reporting"), {
          updates: { cacheRoot: join(root, "updates"), distribution: "github", mode: "enabled" },
        }),
      );
      const update = cli.checkForUpdates();
      try {
        await Promise.race([
          arrived,
          update.then(() => {
            throw new Error("update settled before reaching the server");
          }),
        ]);
        if (outcome !== "success") throw new Error(outcome);
      } catch (e) {
        assert.equal(e.message, outcome);
      } finally {
        assert.deepEqual(await cli.complete(), { reporting: { ok: true, value: false } });
      }
      const result = await update;
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "Cancelled");
      assert.equal((await cli.checkForUpdates()).error.code, "Cancelled");
      await assert.rejects(fs.stat(join(root, "reporting")), { code: "ENOENT" });
    } finally {
      await s.close();
    }
  }
});

test("synthetic CLI preserves stdout and exit status while updates work without reporting", async () => {
  let updateCalls = 0,
    reportingCalls = 0;
  const s = await server((req, res) => {
    if (!req.url.startsWith("/v1/versions/")) {
      reportingCalls++;
      return res.writeHead(503).end();
    }
    updateCalls++;
    assert.equal(req.headers.dnt, "1");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  try {
    for (const declined of [false, true]) {
      const root = await fs.mkdtemp(join(fixture, "synthetic-cli-"));
      const options = cliOptions(s.origin, join(root, "reporting"), {
        policy: { doNotTrack: true },
        updates: { cacheRoot: join(root, "updates"), distribution: "github", mode: "enabled" },
      });
      const code = `const {CliClient}=require(process.argv[1]); (async()=>{const c=new CliClient(${JSON.stringify(options)}); try {${declined ? "await c.withdrawReporting();" : ""} await c.recordInvocation('build'); process.stdout.write('{"command":"ok"}\\n'); const u=await c.checkForUpdates(); if(u.ok&&u.value)process.stderr.write('Update '+u.value.latestVersion+'; run host guidance\\n'); process.exitCode=7;}finally{await c.complete();}})().catch(()=>{process.exitCode=99;});`;
      const result = await installedProcess(code);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(result.stdout, '{"command":"ok"}\n');
      assert.match(result.stderr, /^Update 1\.2\.3; run host guidance\n$/);
      if (!declined) await assert.rejects(fs.stat(join(root, "reporting")), { code: "ENOENT" });
    }
    assert.equal(updateCalls, 2);
    assert.equal(reportingCalls, 0);
    // Broken reporting storage is advisory in ordinary execution, observable in settings.
    const root = await fs.mkdtemp(join(fixture, "broken-cli-"));
    const occupied = join(root, "occupied");
    await fs.writeFile(occupied, "synthetic");
    const cli = new CliClient(cliOptions(s.origin, occupied));
    await assert.rejects(cli.enableReporting({ consent: "informed" }), { code: "State" });
    assert.equal((await cli.recordInvocation("build")).ok, false);
    assert.equal((await cli.complete()).reporting.ok, false);
  } finally {
    await s.close();
  }
});

test("CLI offline mode vetoes update traffic; policy opt-outs send DNT without disabling updates", async () => {
  const s = await server((req, res) => {
    assert.equal(req.headers.dnt, "1");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(freshRelease()));
  });
  const previous = process.env.DO_NOT_TRACK;
  try {
    for (const offline of [true, false]) {
      const root = await fs.mkdtemp(join(fixture, "cli-policy-"));
      process.env.DO_NOT_TRACK = "1";
      const cli = new CliClient(
        cliOptions(s.origin, join(root, "reporting"), {
          policy: { offline, doNotTrack: false },
          updates: {
            cacheRoot: join(root, "cache"),
            distribution: "github",
            mode: "enabled",
            serviceMetrics: true,
          },
        }),
      );
      const result = await cli.checkForUpdates();
      assert.equal(result.ok, true);
      assert.equal(!!result.value, !offline);
      await cli.complete();
      await assert.rejects(fs.stat(join(root, "reporting")), { code: "ENOENT" });
      if (offline) await assert.rejects(fs.stat(join(root, "cache")), { code: "ENOENT" });
    }
    const root = join(fixture, "invalid-cli-mapping");
    for (const metric of ["__proto__", "constructor", "unregistered"])
      assert.throws(
        () =>
          new CliClient(
            cliOptions(s.origin, root, {
              invocation: { metric, categories: { build: { command: "build" } } },
            }),
          ),
        { code: "Configuration" },
      );
    assert.throws(
      () =>
        new CliClient(
          cliOptions(s.origin, root, {
            updates: {
              cacheRoot: root,
              distribution: "github",
              mode: "enabled",
              serviceMetrics: "yes",
            },
          }),
        ),
      { code: "Configuration" },
    );
  } finally {
    if (previous === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = previous;
    await s.close();
  }
});
