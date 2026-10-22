import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import {
  githubDocument,
  npmDocument,
  NOW,
  path,
  request,
  versionFixture,
} from "../test/helpers.ts";

type Handler = (request: Request) => Promise<Response>;
let handle: Handler | undefined;
let requests = 0;
const bundle = await readFile("dist/edge.js", "utf8");
runInNewContext(bundle, {
  Bunny: {
    v1: {
      serve(value: Handler) {
        handle = value;
      },
    },
  },
  Request,
  Response,
  Headers,
  URL,
  TextEncoder,
  TextDecoder,
  AbortController,
  crypto,
  setTimeout,
  clearTimeout,
  Date: class extends Date {
    static now() {
      return NOW;
    }
  },
  fetch: async (url: URL) => {
    requests++;
    return Response.json(url.hostname === "api.github.com" ? githubDocument() : npmDocument());
  },
});
assert.ok(handle, "The shipped SDK must register the HTTP handler through Bunny.v1.serve");
assert.equal(requests, 0, "Importing the bundle must not start a network request");
const version = await handle(request(path));
assert.equal(version.status, 200);
assert.deepEqual(await version.json(), versionFixture());
assert.equal((await handle(request("/v1/versions/dalo/standalone/stable"))).status, 200);
assert.equal((await handle(request("/health"))).headers.get("cache-control"), "no-store");
assert.equal(requests, 2);
console.log(
  "Deployment bundle: SDK registration, version contract, and health passed (local runtime harness).",
);
