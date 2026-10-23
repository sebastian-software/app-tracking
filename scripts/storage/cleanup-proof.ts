import { readFile, unlink } from "node:fs/promises";
import { bunnyApi, required } from "../bunny.ts";
export async function cleanupProof() {
  let target: { scriptId: number; zoneId: number; base: string };
  try {
    target = JSON.parse(await readFile(".deployment/proof-target.json", "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (
    !Number.isSafeInteger(target.scriptId) ||
    target.scriptId <= 0 ||
    !Number.isSafeInteger(target.zoneId) ||
    target.zoneId <= 0 ||
    !/^https:\/\/app-tracking-proof-[a-z0-9-]+\.b-cdn\.net$/.test(target.base)
  )
    throw new Error("Invalid cleanup target");
  const key = required("BUNNY_API_KEY"),
    api = bunnyApi(key);
  async function exists(path: string) {
    const response = await fetch(`https://api.bunny.net${path}`, {
      headers: { AccessKey: key },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("Cleanup verification unavailable");
    return true;
  }
  const script = `/compute/script/${target.scriptId}`,
    zone = `/pullzone/${target.zoneId}`;
  if (await exists(script)) await api("DELETE", `${script}?deleteLinkedPullZones=true`);
  if (await exists(zone)) await api("DELETE", zone);
  if ((await exists(script)) || (await exists(zone))) throw new Error("Cleanup did not converge");
  await unlink(".deployment/proof-target.json");
  console.log("Temporary proof script, encrypted secrets, and Pull Zone removed.");
}
if (import.meta.main) {
  try {
    await cleanupProof();
  } catch {
    console.error("Temporary proof cleanup needs private operator attention.");
    process.exitCode = 1;
  }
}
