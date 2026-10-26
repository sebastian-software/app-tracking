import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cleanupProof } from "./cleanup-proof.ts";
import { cleanupProbe, verifyTelemetry } from "../verify-telemetry.ts";
import { verifyDeployment, waitForRevision } from "../verify-deployment.ts";

const token = randomBytes(32).toString("hex");
const suffix = `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
const env = {
  ...process.env,
  PROOF_AUTH_TOKEN: token,
  PROOF_BUNDLE: "runtime",
  PROOF_SCRIPT_NAME: `app-tracking-proof-runtime-${suffix}`,
  PROOF_ZONE_NAME: `app-tracking-proof-runtime-${suffix}`,
};
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
try {
  await cleanupProof();
  const deployed = spawnSync(process.execPath, ["scripts/storage/deploy-proof.ts"], {
    env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (deployed.status !== 0) throw new Error("Synthetic publish failed");
  const target = JSON.parse(await readFile(".deployment/proof-target.json", "utf8"));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const authenticatedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-App-Tracking-Proof", token);
    return fetch(input, { ...init, headers });
  };
  await waitForRevision(target.base, revision, authenticatedFetch);
  await verifyDeployment(target.base, revision, authenticatedFetch, true);
  console.log(JSON.stringify(await verifyTelemetry({ base: target.base, proofToken: token })));
  for (const [method, path] of [
    ["POST", "/v1/usage-batches"],
    ["PUT", "/v1/installations/00000000-0000-7000-8000-000000000001"],
    ["DELETE", "/v1/installations/00000000-0000-7000-8000-000000000001"],
  ]) {
    const response = await fetch(new URL(path, target.base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 404);
    assert.notEqual(response.headers.get("cdn-cache")?.toUpperCase(), "HIT");
    await response.body?.cancel();
  }
  console.log(JSON.stringify({ anonymous_probe_access_denied: true }));
} catch {
  console.error(
    "Synthetic Bunny runtime proof failed; no public production activation or private data was logged.",
  );
  process.exitCode = 1;
} finally {
  try {
    await cleanupProbe();
    await cleanupProof();
  } catch {
    console.error("Synthetic fixture/resource cleanup needs private attention.");
    process.exitCode = 1;
  }
}
