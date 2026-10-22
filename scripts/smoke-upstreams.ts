import assert from "node:assert/strict";
import { catalog, versionPath } from "../src/catalog.ts";
import { createHandler } from "../src/handler.ts";

// Explicit live check; never part of the deterministic check/CI command.
const handle = createHandler();
for (const entry of catalog) {
  const route = versionPath(entry);
  const response = await handle(new Request(`https://example.com${route}`));
  const payload = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(payload)}`);
  console.log(JSON.stringify({ route, status: response.status, ...payload }));
}
