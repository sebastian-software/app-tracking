const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { after, before, test } = require("node:test");

let fixture, installed, Client, TrackingError;
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

before(async () => {
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
  await fs.mkdir(installed, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(fixture, Object.values(packed)[0].filename),
    "--strip-components=1",
    "-C",
    installed,
  ]);
  ({ Client, TrackingError } = require(installed));
  const typeConsumer = join(fixture, "consumer.mts");
  await fs.writeFile(
    typeConsumer,
    `import { Client, TrackingError, type Status, type VerifiedDownload } from '@sebastian-software/app-tracking';\nconst c = new Client({origin:'https://example.com',stateRoot:'/synthetic/private',tool:'ferriki',version:'1.2.3'});\nconst s: Promise<Status> = c.status();\nconst d: Promise<VerifiedDownload> = c.download({id:'grammar',url:'https://example.com/grammar',bytes:0,sha256:'0'.repeat(64)});\nconst code: string = new TrackingError('Busy').code;\n`,
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
});

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
      const { eventBatch } = await import("../../../src/telemetry/events.ts");
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
    const script = `const { Client } = require(${JSON.stringify(installed)}); const c = new Client(${JSON.stringify({ origin: "http://127.0.0.1:1", stateRoot, tool: "ferriki", version: "1.2.3", interaction: "never" })}); (async()=>{ for(let n=0;n<20;n++){ for(let retry=0;;retry++){try{await c.record("language.use", ${JSON.stringify(dimensions)});break;}catch(e){if(e.code!=="Busy"||retry>200)throw e;await new Promise(r=>setTimeout(r,2));}} } })().catch(()=>{process.exitCode=1});`;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = spawn(process.execPath, ["-e", script], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        const [code] = await once(child, "exit");
        assert.equal(code, 0);
      }),
    );
    assert.equal((await c.preview()).open[0].count, 60);
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
