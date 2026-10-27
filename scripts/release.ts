import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { bunnyApi, required, type BunnyApi } from "./bunny.ts";
import type { Target } from "./provision.ts";
export async function publish(api: BunnyApi, target: Target, code: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("A full commit revision is required");
  await api("POST", `/compute/script/${target.scriptId}/code`, { Code: code });
  await api("POST", `/compute/script/${target.scriptId}/publish`, { Note: revision });
  await api("POST", `/pullzone/${target.zoneId}/purgeCache`, {});
}
if (import.meta.main) {
  const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
  const code = await readFile("dist/edge.js", "utf8");
  const revision = required("RELEASE_REVISION");
  const hash = createHash("sha256").update(code).digest("hex");
  if (!code.includes(revision))
    throw new Error("Bundle revision does not match deployment revision");
  await publish(bunnyApi(required("BUNNY_API_KEY")), target, code, revision);
  await writeFile(
    "dist/release.json",
    JSON.stringify({
      revision,
      sha256: hash,
      telemetry: process.env.TELEMETRY_ENABLED === "1",
      reporting: process.env.REPORTING_ENABLED === "1",
    }) + "\n",
  );
  console.log(
    "Bundle published and zone purge requested; endpoint verification is still required.",
  );
}
