import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bunnyApi, required } from "./bunny.ts";
import { publish } from "./release.ts";
import { verifyDeployment, waitForRevision } from "./verify-deployment.ts";
import type { Target } from "./provision.ts";
// Restore an immutable artifact from a previously verified release, never rebuilt source.
const manifest: {
  revision: string;
  sha256: string;
  telemetry?: boolean;
  reporting?: boolean;
  events?: boolean;
} = JSON.parse(await readFile("rollback/release.json", "utf8"));
if (!/^[a-f0-9]{40}$/.test(manifest.revision)) throw new Error("Invalid rollback revision");
execFileSync("git", ["merge-base", "--is-ancestor", manifest.revision, "origin/main"]);
const code = await readFile("rollback/edge.js", "utf8");
if (
  createHash("sha256").update(code).digest("hex") !== manifest.sha256 ||
  !code.includes(manifest.revision)
)
  throw new Error("Rollback artifact integrity failure");
const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
const api = bunnyApi(required("BUNNY_API_KEY"));
const telemetryEnabled = manifest.telemetry === true && process.env.TELEMETRY_ENABLED === "1";
await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
  Name: "APP_TRACKING_TELEMETRY_ENABLED",
  Secret: telemetryEnabled ? "1" : "0",
});
const reportingEnabled = manifest.reporting === true && process.env.REPORTING_ENABLED === "1";
await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
  Name: "APP_TRACKING_REPORTING_ENABLED",
  Secret: reportingEnabled ? "1" : "0",
});
await publish(api, target, code, manifest.revision);
await waitForRevision(target.base, manifest.revision);
await verifyDeployment(
  target.base,
  manifest.revision,
  fetch,
  telemetryEnabled,
  reportingEnabled,
  manifest.events === true,
);
console.log("Rollback restored the verified artifact; CDN purge and contract checks passed.");
