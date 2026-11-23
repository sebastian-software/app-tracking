import assert from "node:assert/strict";
import test from "node:test";
import { bunnyApi } from "../scripts/bunny.ts";

const path = "/pullzone/loadFreeCertificate?hostname=downloads.ferriki.dev";

test("Bunny certificate loading accepts an empty HTTP 200 response", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  assert.equal(await bunnyApi("synthetic-key")("GET", path), undefined);
  assert.equal(fetch.mock.calls.length, 1);
  await assert.rejects(bunnyApi("synthetic-key")("GET", "/pullzone/1"), SyntaxError);
});

test("Bunny certificate loading still rejects provider errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(bunnyApi("synthetic-key")("GET", path), {
    message: "Bunny operation failed (503)",
  });
});
