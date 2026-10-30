import { bunnyApi, required, type BunnyApi } from "./bunny.ts";
import { SETTINGS } from "./provision.ts";

// Bunny Shield v1 enums: https://api.bunny.net/shield/docs/v1/swagger.json
// Explicit Basic avoids the provider's paid Advanced default and browser challenges.
export const SHIELD_SETTINGS = {
  planType: 0,
  learningMode: false,
  wafEnabled: true,
  wafExecutionMode: 1, // Block.
  wafRequestHeaderLoggingEnabled: false,
  requestBodyLoggingEnabled: false,
  dDoSShieldSensitivity: 1, // Low; never force a browser challenge for every request.
};
const GATEWAY_LIMITS = { RequestLimit: SETTINGS.RequestLimit, BurstSize: SETTINGS.BurstSize };
interface ShieldZone extends Record<string, unknown> {
  shieldZoneId: number;
  pullZoneId: number;
  planType: number;
}
async function readZone(api: BunnyApi, pullZoneId: number) {
  const matches: ShieldZone[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api<{
      data: ShieldZone[] | null;
      page: { nextPage: number | null } | null;
    }>("GET", `/shield/shield-zones?perPage=100&page=${page}`);
    if (result.data !== null && !Array.isArray(result.data))
      throw new Error("Invalid Shield listing");
    matches.push(...(result.data ?? []).filter((zone) => zone.pullZoneId === pullZoneId));
    if (matches.length > 1) throw new Error("Ambiguous Shield zone");
    if ((!result.data?.length && !result.page) || result.page?.nextPage === null)
      return matches[0] as ShieldZone | undefined;
    if (result.page?.nextPage !== page + 1) throw new Error("Invalid Shield pagination");
  }
  throw new Error("Shield discovery exceeded page limit");
}
function matches(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export async function configureShield(api: BunnyApi, pullZoneId: number, apply = false) {
  if (!Number.isSafeInteger(pullZoneId) || pullZoneId < 1) throw new Error("Invalid pull zone");
  let zone = await readZone(api, pullZoneId);
  let gateway = await api<Record<string, unknown>>("GET", `/pullzone/${pullZoneId}`);
  let changes = 0;
  if (zone && zone.planType !== 0)
    throw new Error("Existing paid Shield plan requires separate review");
  if (apply) {
    if (!zone) {
      // Do not request unavailable Basic add-ons such as bot detection or upload scanning.
      await api("POST", "/shield/shield-zone", { pullZoneId, shieldZone: SHIELD_SETTINGS });
      changes++;
    } else if (!matches(zone, SHIELD_SETTINGS)) {
      await api("PATCH", "/shield/shield-zone", {
        shieldZoneId: zone.shieldZoneId,
        shieldZone: SHIELD_SETTINGS,
      });
      changes++;
    }
    if (!matches(gateway, GATEWAY_LIMITS)) {
      await api("POST", `/pullzone/${pullZoneId}`, GATEWAY_LIMITS);
      changes++;
    }
    // Successful HTTP responses alone are insufficient; verify the effective configuration.
    zone = await readZone(api, pullZoneId);
    gateway = await api<Record<string, unknown>>("GET", `/pullzone/${pullZoneId}`);
  }
  const verified =
    !!zone &&
    matches(zone, SHIELD_SETTINGS) &&
    zone.dDoSExecutionMode === 1 &&
    matches(gateway, GATEWAY_LIMITS);
  if (apply && !verified) throw new Error("Shield or gateway settings did not converge");
  // Only selected configuration is logged, never account IDs, request data, or credentials.
  return {
    configured: !!zone,
    verified,
    changes,
    configuration: Object.fromEntries(
      Object.keys(SHIELD_SETTINGS).map((key) => [key, zone?.[key]]),
    ),
    ddosBlocking: zone?.dDoSExecutionMode === 1,
    gatewayRequestsPerSecondPerIp: gateway.RequestLimit,
    gatewayBurst: gateway.BurstSize,
  };
}
async function productionPullZone(api: BunnyApi) {
  const scripts = await api<{ Items: { Id: number; Name: string }[] }>(
    "GET",
    "/compute/script?search=app-tracking&type=1&includeLinkedPullzones=true&perPage=100&page=1",
  );
  const matching = scripts.Items.filter((script) => script.Name === "app-tracking");
  if (matching.length !== 1) throw new Error("Expected exactly one production script");
  const script = await api<{ LinkedPullZones: { Id: number; PullZoneName: string }[] }>(
    "GET",
    `/compute/script/${matching[0].Id}`,
  );
  const zones = script.LinkedPullZones.filter(
    (zone) => zone.PullZoneName === "sebastian-app-tracking",
  );
  if (zones.length !== 1) throw new Error("Expected exactly one production pull zone");
  return zones[0].Id;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
    throw new Error("Usage: node scripts/shield.ts [--apply]");
  const api = bunnyApi(required("BUNNY_API_KEY"));
  console.log(
    JSON.stringify(
      await configureShield(api, await productionPullZone(api), args[0] === "--apply"),
    ),
  );
}
