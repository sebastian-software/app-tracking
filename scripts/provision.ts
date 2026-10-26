import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { bunnyApi, required, type BunnyApi } from "./bunny.ts";
export const SETTINGS = {
  IgnoreQueryStrings: false,
  EnableSmartCache: false,
  CacheControlMaxAgeOverride: -1,
  CacheControlPublicMaxAgeOverride: -1,
  CacheErrorResponses: false,
  UseStaleWhileUpdating: false,
  UseStaleWhileOffline: false,
  EnableLogging: false,
  LogForwardingEnabled: false,
  LoggingSaveToStorage: false,
  RequestLimit: 20,
  BurstSize: 40,
  EdgeScriptExecutionPhase: 0,
};
interface Script {
  Id: number;
  Name: string;
  LinkedPullZones?: { Id: number; PullZoneName: string }[];
}
export interface Target {
  scriptId: number;
  zoneId: number;
  base: string;
}
export async function provision(
  api: BunnyApi,
  name: string,
  zone: string,
): Promise<{ target: Target; changes: number }> {
  if (!/^[a-z0-9-]{1,80}$/.test(name) || !/^[a-z0-9-]{1,80}$/.test(zone))
    throw new Error("Invalid deployment name");
  const found: Script[] = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Script discovery exceeded page limit");
    const list = await api<{ Items: Script[] }>(
      "GET",
      `/compute/script?search=${name}&type=1&includeLinkedPullzones=true&perPage=100&page=${page}`,
    );
    found.push(...list.Items.filter((s) => s.Name === name));
    if (list.Items.length < 100) break;
  }
  if (found.length > 1) throw new Error("Ambiguous deployment target");
  let script = found[0];
  let changes = 0;
  if (!script) {
    script = await api<Script>("POST", "/compute/script", {
      Name: name,
      Code: "export {};",
      ScriptType: 1,
      CreateLinkedPullZone: true,
      LinkedPullZoneName: zone,
    });
    changes++;
  }
  const details = await api<Script>("GET", `/compute/script/${script.Id}`);
  const linked = details.LinkedPullZones?.filter((z) => z.PullZoneName === zone);
  if (linked?.length !== 1)
    throw new Error("Linked zone does not match the intended isolated target");
  const zoneId = linked[0].Id;
  const current = await api<Record<string, unknown>>("GET", `/pullzone/${zoneId}`);
  // Never silently inherit a broad TTL override from an older deployment.
  const rules = (current.EdgeRules ?? current.Edgerules ?? []) as unknown[];
  if (rules.length) throw new Error("Unexpected edge rules require review before deployment");
  const drift = Object.fromEntries(Object.entries(SETTINGS).filter(([k, v]) => current[k] !== v));
  if (Object.keys(drift).length) {
    await api("POST", `/pullzone/${zoneId}`, drift);
    changes++;
  }
  const verified = await api<Record<string, unknown>>("GET", `/pullzone/${zoneId}`);
  if (Object.entries(SETTINGS).some(([k, v]) => verified[k] !== v))
    throw new Error("Pull zone settings did not converge");
  return { target: { scriptId: script.Id, zoneId, base: `https://${zone}.b-cdn.net` }, changes };
}
if (import.meta.main) {
  const result = await provision(
    bunnyApi(required("BUNNY_API_KEY")),
    required("SCRIPT_NAME"),
    required("ZONE_NAME"),
  );
  await mkdir(".deployment", { recursive: true });
  await writeFile(".deployment/target.json", JSON.stringify(result.target), { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    console.log(`::add-mask::${result.target.base}`);
    await appendFile(process.env.GITHUB_OUTPUT, `base=${result.target.base}\n`);
  }
  console.log(JSON.stringify({ changes: result.changes }));
}
