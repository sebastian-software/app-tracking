import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bunnyApi, required } from "./bunny.ts";
import { publish } from "./release.ts";
import { waitForRevision, verifyDeployment } from "./verify-deployment.ts";
import type { Target } from "./provision.ts";
if (required("DEPLOYMENT_ENVIRONMENT") !== "staging")
  throw new Error("Fault injection is staging-only");
const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
const api = bunnyApi(required("BUNNY_API_KEY"));
const script = await api<{ Name: string }>("GET", `/compute/script/${target.scriptId}`);
if (script.Name !== "app-tracking-staging")
  throw new Error("Refusing to inject faults into any other script");
const revision = required("RELEASE_REVISION");
const original = await readFile("dist/edge.js", "utf8");
const synthetic = await readFile("dist/drill.js", "utf8");
const probe = async (path: string) =>
  fetch(new URL(path, target.base), { redirect: "error", signal: AbortSignal.timeout(10000) });
try {
  await publish(api, target, synthetic, revision);
  await waitForRevision(target.base, revision + "-drill");
  let origin: string | null = null;
  for (let n = 0; n < 8; n++) {
    const r = await probe("/probe/fresh");
    assert.equal(r.status, 200);
    origin = r.headers.get("x-probe-origin");
    if (r.headers.get("cdn-cache")?.toUpperCase() === "HIT") break;
    if (n === 7) assert.fail("Synthetic cache did not warm");
  }
  assert.ok(origin);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const expired = await probe("/probe/fresh");
  assert.equal(expired.status, 200);
  assert.notEqual(
    expired.headers.get("x-probe-origin"),
    origin,
    "A two-second response remained cached after expiry",
  );
  let beforePurge: string | null = null;
  for (let n = 0; n < 8; n++) {
    const r = await probe("/probe/purge");
    beforePurge = r.headers.get("x-probe-origin");
    if (r.headers.get("cdn-cache")?.toUpperCase() === "HIT") break;
    if (n === 7) assert.fail("The purge fixture did not warm");
  }
  assert.ok(beforePurge);
  await api("POST", `/pullzone/${target.zoneId}/purgeCache`, {});
  let purged = false;
  for (let n = 0; n < 30; n++) {
    const r = await probe("/probe/purge");
    if (r.headers.get("x-probe-origin") !== beforePurge) {
      purged = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(purged, "A ten-minute cache entry did not change after purge");
  for (const [path, status, stale] of [
    ["/probe/stale", 200, true],
    ["/probe/expired", 503, undefined],
    ["/probe/cold", 503, undefined],
  ] as const) {
    const r = await probe(path);
    assert.equal(r.status, status);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const data = await r.json();
    if (stale !== undefined) assert.equal(data.stale, stale);
  }
  console.log(
    "Synthetic Bunny expiry, purge, warm-registry outage, stale-age boundary, and cold-outage drills passed.",
  );
} finally {
  // Re-publish the exact verified original bytes, even when a drill assertion fails.
  await publish(api, target, original, revision);
  await waitForRevision(target.base, revision);
  await verifyDeployment(target.base, revision);
  console.log("Original verified bundle restored and its live contract reverified.");
}
