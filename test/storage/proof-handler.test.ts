import { test } from "node:test";
import assert from "node:assert/strict";
import { createProofHandler } from "../../src/storage/proof-handler.ts";

test("unsupported edge memory sampling preserves the committed acknowledgement", async () => {
  const originalFetch = globalThis.fetch;
  const originalDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      memoryUsage() {
        throw new Error("unsupported runtime operation");
      },
    },
  });
  globalThis.fetch = async () =>
    Response.json({
      fields: [{ name: "result", dataTypeID: 3802 }],
      rows: [[JSON.stringify({ status: "accepted" })]],
      rowCount: 1,
      command: "SELECT",
      rowAsArray: true,
    });
  try {
    const handle = createProofHandler(
      "postgresql://synthetic:synthetic@fixture.pg.psdb.cloud/postgres",
      "a".repeat(64),
    );
    const response = await handle(
      new Request("https://example.test/proof/submit", {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "synthetic",
          token_hash: "b".repeat(64),
          batch_id: "synthetic",
          content_hash: "c".repeat(64),
          rows: [],
        }),
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.status, "accepted");
    assert.equal(body.subrequests, 1);
    assert.equal(body.memory_source, "process");
    assert.ok(body.heap_used_bytes > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno) Object.defineProperty(globalThis, "Deno", originalDeno);
    else Reflect.deleteProperty(globalThis, "Deno");
  }
});
