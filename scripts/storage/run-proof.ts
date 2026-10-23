import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cleanupProof } from "./cleanup-proof.ts";

// Keep the token in memory and deploy only a short-lived synthetic endpoint.
const suffix = process.env.GITHUB_RUN_ID ?? String(Date.now());
const env = {
  ...process.env,
  PROOF_AUTH_TOKEN: randomBytes(32).toString("hex"),
  PROOF_SCRIPT_NAME: `app-tracking-proof-${suffix}`,
  PROOF_ZONE_NAME: `app-tracking-proof-${suffix}`,
};
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${env.PROOF_AUTH_TOKEN}`);
try {
  await cleanupProof();
  const deploy = spawnSync(process.execPath, ["scripts/storage/deploy-proof.ts"], {
    env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (deploy.status !== 0) throw new Error("deploy");
  const verify = spawnSync(process.execPath, ["scripts/storage/verify-proof.ts"], {
    env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (verify.status !== 0) throw new Error("verify");
} catch {
  console.error("Synthetic proof failed; no production version deployment was changed.");
  process.exitCode = 1;
} finally {
  try {
    await cleanupProof();
  } catch {
    console.error("Temporary proof cleanup needs private operator attention.");
    process.exitCode = 1;
  }
}
