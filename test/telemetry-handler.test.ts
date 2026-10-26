import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTelemetryHandler, type TelemetryStorage } from "../src/telemetry/handler.ts";
import { batch, canonicalBatch, sha256, policy } from "../src/telemetry/contract.ts";
import { strictJSON } from "../src/telemetry/json.ts";
import { createHandler } from "../src/handler.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = read("./fixtures/telemetry/valid.json");
const token = "a".repeat(64);
const path = `/v1/installations/${fixture.batch.installation_id}`;
function request(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method?: string,
) {
  return new Request(`https://example.invalid${url}`, {
    method: method ?? (url.startsWith("/v1/installations/") ? "PUT" : "POST"),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function setup() {
  const calls: { operation: string; args: unknown[] }[] = [];
  const storage: TelemetryStorage = {
    async registerV1(...args) {
      calls.push({ operation: "register", args });
      return {
        result:
          args[3] === "telemetry-v1"
            ? { status: "registered" }
            : { status: "", error: "consent_required" },
        subrequests: 1,
        database_ms: 1,
      };
    },
    async submitV1(...args) {
      calls.push({ operation: "submit", args });
      const error =
        args[5] !== "telemetry-v1"
          ? "consent_required"
          : args[6].some((r) => !policy.tools.dalo.commands.includes(r.command))
            ? "invalid_request"
            : undefined;
      return {
        result: error ? { status: "", error } : { status: "accepted", received_at: fixture.now },
        subrequests: 1,
        database_ms: 1,
      };
    },
  };
  return { calls, storage, handle: createTelemetryHandler(storage) };
}
async function code(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= policy.max_response_bytes);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "schema_version"]);
  assert.deepEqual(Object.keys(parsed.error), ["code"]);
  assert.equal(parsed.schema_version, 1);
  return parsed.error.code;
}

test("production version handler still has no telemetry mutation routes", async () => {
  const handle = createHandler({
    fetch: async () => {
      throw new Error("No version fetch expected");
    },
  });
  for (const req of [
    request(path, fixture.registration),
    request("/v1/usage-batches", fixture.batch),
  ])
    assert.notEqual((await handle(req)).status, 200);
});
test("registration derives domain-separated credential hash and returns the fixed acknowledgement", async () => {
  const { handle, calls } = setup();
  const response = await handle(request(path, fixture.registration));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    schema_version: 1,
    installation_id: fixture.batch.installation_id,
    status: "registered",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].args[2],
    await sha256(`app-tracking-token-v1\n${fixture.batch.installation_id}\n${token}`),
  );
  assert.ok(!JSON.stringify(calls).includes(token));
});
test("canonical bytes and hash match independent vectors; key/row order and integer spelling do not matter", async () => {
  const { handle, calls } = setup();
  assert.equal(canonicalBatch(batch(fixture.batch)), fixture.canonical_utf8);
  assert.equal(await sha256(canonicalBatch(batch(fixture.batch))), fixture.payload_sha256);
  const value = { ...fixture.batch, rows: [...fixture.batch.rows].reverse() };
  const response = await handle(
    request("/v1/usage-batches", JSON.stringify(value).replace('"count":12', '"count":12.0')),
  );
  assert.equal(response.status, 200);
  const ack = await response.json();
  assert.equal(ack.payload_sha256, fixture.payload_sha256);
  assert.equal(ack.received_at, fixture.now);
  assert.equal(calls[0].args[4], fixture.payload_sha256);
});
for (const c of read("./fixtures/telemetry/shape-cases.json")) {
  test(`HTTP wire fixture: ${c.name}`, async () => {
    const value = structuredClone(fixture[c.definition]);
    for (const change of c.changes) {
      let parent = value;
      for (const key of change.path.slice(0, -1)) parent = parent[key];
      const key = change.path.at(-1);
      if (change.remove) delete parent[key];
      else parent[key] = change.value;
    }
    const { handle } = setup();
    const response = await handle(
      request(c.definition === "registration" ? path : "/v1/usage-batches", value),
    );
    assert.equal(response.ok, c.valid, c.name);
  });
}
for (const text of [
  '{"a":1,"a":2}',
  '{"a":1,"\\u0061":2}',
  '{"nested":{"x":1,"x":1}}',
  '{"x":NaN}',
  '{"x":Infinity}',
  '{"x":1e999}',
  '{"x":01}',
  '{"x":1.00000000000000001}',
  '{"x":1e-999}',
  '{"x":9007199254740993}',
  '{"x":1,}',
  "[1,]",
  "{} trailing",
  "\ufeff{}",
  "[[[".repeat(20),
])
  test(`strict JSON rejects ${text.slice(0, 50)}`, () => assert.throws(() => strictJSON(text)));
test("strict JSON accepts exact alternate integer spellings and distinguishes decoded keys", () => {
  assert.equal(
    JSON.stringify(strictJSON('{"x":1.0,"y":10e-1,"z":-0.0,"__proto__":1}')),
    '{"x":1,"y":1,"z":0,"__proto__":1}',
  );
});
test("duplicate keys, invalid UTF-8, BOM and trailing data never reach storage", async () => {
  const { handle, calls } = setup();
  for (const body of [
    JSON.stringify(fixture.registration).replace(
      '"schema_version":1',
      '"schema_version":1,"schema_version":1',
    ),
    "\ufeff" + JSON.stringify(fixture.registration),
    JSON.stringify(fixture.registration) + "{}",
  ]) {
    assert.equal(await code(await handle(request(path, body))), "invalid_request");
  }
  const req = new Request(`https://example.invalid${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: new Uint8Array([0xc3, 0x28]),
  });
  assert.equal(await code(await handle(req)), "invalid_request");
  assert.equal(calls.length, 0);
});
test("exact registration and batch byte limits are accepted; one extra byte is rejected without writes", async () => {
  const { handle, calls } = setup();
  for (const [url, value, limit] of [
    [path, fixture.registration, 1024],
    ["/v1/usage-batches", fixture.batch, 65536],
  ] as const) {
    const raw = JSON.stringify(value).padEnd(limit, " ");
    assert.equal((await handle(request(url, raw))).ok, true);
    const before = calls.length;
    const tooLarge = await handle(request(url, raw + " "));
    assert.equal(tooLarge.status, 413);
    assert.equal(await code(tooLarge), "payload_too_large");
    assert.equal(calls.length, before);
  }
});
test("streamed overflow is cancelled before the remainder is read", async () => {
  const { handle, calls } = setup();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(1025));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request(`https://example.invalid${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.equal((await handle(req)).status, 413);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});
test("stalled input is cancelled at the shared request deadline without touching storage", async () => {
  const { handle, calls } = setup();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request(`https://example.invalid${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const keepAlive = setTimeout(() => {}, 4000);
  try {
    const response = await handle(req);
    assert.equal(response.status, 503);
    assert.equal(await code(response), "service_unavailable");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});
test("transport rejects queries, malformed routes, cookies, compression, excess headers and wrong methods", async () => {
  const { handle, calls } = setup();
  for (const suffix of ["?x=1", "?", "#x"])
    assert.equal(
      await code(await handle(request(path + suffix, fixture.registration))),
      "invalid_request",
    );
  assert.equal(
    (await handle(request(path.replace(/.$/, "%31"), fixture.registration))).status,
    400,
  );
  assert.equal((await handle(request(path + "/extra", fixture.registration))).status, 404);
  assert.equal((await handle(request(path, fixture.registration, { cookie: "x=y" }))).status, 400);
  assert.equal(
    (await handle(request(path, fixture.registration, { "content-encoding": "gzip" }))).status,
    415,
  );
  assert.equal(
    (await handle(request(path, fixture.registration, { "content-type": "text/plain" }))).status,
    415,
  );
  assert.equal(
    (await handle(request(path, fixture.registration, { "x-padding": "x".repeat(16384) }))).status,
    400,
  );
  const method = await handle(request(path, fixture.registration, {}, "POST"));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "PUT");
  assert.equal(calls.length, 0);
});
test("missing/malformed credentials and declared overflow cannot write", async () => {
  const { handle, calls } = setup();
  for (const authorization of [
    "",
    `Bearer ${"a".repeat(63)}`,
    `Bearer ${"A".repeat(64)}`,
    `Bearer ${token}, Bearer ${token}`,
  ])
    assert.equal(
      await code(await handle(request(path, fixture.registration, { authorization }))),
      "unauthorized",
    );
  assert.equal(
    (await handle(request(path, fixture.registration, { "content-length": "1025" }))).status,
    413,
  );
  assert.equal(
    (await handle(request(path, fixture.registration, { "content-length": "1" }))).status,
    400,
  );
  assert.equal(calls.length, 0);
});
test("storage failures and unexpected results are redacted; timed out writes remain unknown outcomes", async () => {
  const { storage } = setup();
  storage.submitV1 = async () => {
    throw new Error(`private provider URL and ${token}`);
  };
  let response = await createTelemetryHandler(storage)(request("/v1/usage-batches", fixture.batch));
  assert.equal(response.status, 503);
  assert.equal(await code(response), "service_unavailable");
  storage.submitV1 = async () => ({
    result: { status: "broken", received_at: "secret" },
    database_ms: 1,
    subrequests: 1,
  });
  response = await createTelemetryHandler(storage)(request("/v1/usage-batches", fixture.batch));
  assert.equal(await code(response), "service_unavailable");
  storage.submitV1 = async () => ({
    result: { status: "", error: "rate_limited" },
    database_ms: 1,
    subrequests: 1,
  });
  response = await createTelemetryHandler(storage)(request("/v1/usage-batches", fixture.batch));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
});

test("success waits for the storage acknowledgement", async () => {
  const { storage } = setup();
  let entered!: () => void,
    finish!: (value: Awaited<ReturnType<TelemetryStorage["submitV1"]>>) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  storage.submitV1 = () => {
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  let acknowledged = false;
  const pending = createTelemetryHandler(storage)(request("/v1/usage-batches", fixture.batch));
  void pending.then(() => {
    acknowledged = true;
  });
  await started;
  assert.equal(acknowledged, false);
  finish({
    result: { status: "accepted", received_at: fixture.now },
    subrequests: 1,
    database_ms: 1,
  });
  assert.equal((await pending).status, 200);
});
test("caller cancellation reaches an in-flight write and returns an unknown outcome", async () => {
  const { storage } = setup();
  let entered!: () => void,
    finish!: (value: Awaited<ReturnType<TelemetryStorage["submitV1"]>>) => void;
  let databaseSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  storage.submitV1 = (...args) => {
    databaseSignal = args[7];
    entered();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const controller = new AbortController();
  const req = new Request(request("/v1/usage-batches", fixture.batch), {
    signal: controller.signal,
  });
  const pending = createTelemetryHandler(storage)(req);
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(await code(response), "service_unavailable");
  assert.equal(databaseSignal?.aborted, true);
  finish({
    result: { status: "accepted", received_at: fixture.now },
    subrequests: 1,
    database_ms: 1,
  });
});
