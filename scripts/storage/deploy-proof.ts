import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { bunnyApi, required } from "../bunny.ts";
import { provision } from "../provision.ts";
import { publish } from "../release.ts";
try {
  const name = required("PROOF_SCRIPT_NAME"),
    zone = required("PROOF_ZONE_NAME");
  if (!name.startsWith("app-tracking-proof-") || !zone.startsWith("app-tracking-proof-"))
    throw new Error("Dedicated temporary target required");
  const api = bunnyApi(required("BUNNY_API_KEY"));
  const { target } = await provision(api, name, zone);
  // Persist cleanup identity immediately, even if setting secrets or publishing fails.
  await mkdir(".deployment", { recursive: true });
  await writeFile(".deployment/proof-target.json", JSON.stringify(target), { mode: 0o600 });
  for (const [Name, Secret] of [
    ["PROOF_DATABASE_URL", required("RUNTIME_DATABASE_URL")],
    ["PROOF_AUTH_TOKEN", required("PROOF_AUTH_TOKEN")],
  ]) {
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, { Name, Secret });
  }
  await publish(
    api,
    target,
    await readFile(
      process.env.PROOF_BUNDLE === "runtime" ? "dist/runtime-proof.js" : "dist/storage-proof.js",
      "utf8",
    ),
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
  console.log("Temporary proof published. Target details are in ignored runner state.");
} catch {
  console.error("Proof deployment failed; inspect privately.");
  process.exitCode = 1;
}
