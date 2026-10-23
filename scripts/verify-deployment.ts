import assert from "node:assert/strict";
import { catalog, versionPath } from "../src/catalog.ts";
import { record } from "../src/contract.ts";
export async function verifyDeployment(
  base: string,
  revision: string,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(base);
  assert.equal(url.protocol, "https:");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.username + url.password, "");
  const get = async (path: string, headers?: HeadersInit) => {
    const response = await fetcher(new URL(path, base), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(
      response.headers.get("x-app-revision"),
      revision,
      "Unexpected deployed revision (or stale CDN cache)",
    );
    return response;
  };
  for (const entry of catalog) {
    const path = versionPath(entry);
    let hit = false;
    for (let n = 0; n < 8; n++) {
      const response = await get(path);
      assert.equal(response.status, 200);
      const data = record(await response.json());
      assert.ok(data);
      assert.equal(data.tool_id, entry.tool);
      assert.equal(data.distribution, entry.distribution);
      assert.equal(data.stale, false);
      const age = Date.now() - Date.parse(String(data.checked_at));
      assert.ok(age >= -300_000 && age < 3_600_000, "Version result is not fresh");
      const tag = response.headers.get("etag");
      assert.ok(tag);
      const conditional = await get(path, { "If-None-Match": tag });
      assert.equal(conditional.status, 304);
      assert.equal(await conditional.text(), "");
      hit ||= response.headers.get("cdn-cache")?.toUpperCase() === "HIT";
      if (hit) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(hit, "No CDN cache HIT was observed within the bounded probe");
    for (const invalid of [path + "?unexpected=1", path + "?"]) {
      const response = await get(invalid);
      assert.equal(response.status, 400, "The cache served an invalid query");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.notEqual(response.headers.get("cdn-cache")?.toUpperCase(), "HIT");
    }
  }
  for (const path of ["/health", "/v1/admin/usage", "/v1/usage-batches"]) {
    for (let n = 0; n < 2; n++) {
      const response = await get(path);
      assert.equal(response.status, path === "/health" ? 200 : 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.notEqual(response.headers.get("cdn-cache")?.toUpperCase(), "HIT");
    }
  }
  console.log(
    "Deployment contract, revision, CDN hits, conditional requests, and cache bypass passed.",
  );
}
export async function waitForRevision(
  base: string,
  revision: string,
  fetcher: typeof fetch = fetch,
) {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await fetcher(new URL("/health", base), {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      ready = health.status === 200 && health.headers.get("x-app-revision") === revision;
      await health.body?.cancel();
      if (ready) break;
    } catch {
      /* Publication propagation can temporarily leave an unavailable edge. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "The expected published revision did not become ready within the bounded wait");
}
if (import.meta.main) {
  const base = process.env.DEPLOYMENT_BASE;
  const revision = process.env.RELEASE_REVISION;
  if (!base || !revision) throw new Error("DEPLOYMENT_BASE and RELEASE_REVISION are required");
  await waitForRevision(base, revision);
  await verifyDeployment(base, revision);
}
