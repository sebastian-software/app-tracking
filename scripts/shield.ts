import { bunnyApi, required, type BunnyApi } from "./bunny.ts";

interface ShieldZone {
  shieldZoneId: number;
  pullZoneId: number;
  planType: number;
  learningMode: boolean;
  wafEnabled: boolean;
  wafExecutionMode: number;
  wafRequestHeaderLoggingEnabled: boolean;
  requestBodyLoggingEnabled: boolean;
  dDoSShieldSensitivity: number;
  dDoSExecutionMode: number;
  rateLimitRulesLimit: number;
}

export async function inspectShield(api: BunnyApi) {
  const scripts = await api<{
    Items: { Id: number; Name: string }[];
  }>(
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
  const zoneId = zones[0].Id;
  let shield: ShieldZone | undefined;
  for (let page = 1; page <= 100; page++) {
    const result = await api<{ data: ShieldZone[]; page: { nextPage?: number | null } }>(
      "GET",
      `/shield/shield-zones?perPage=100&page=${page}`,
    );
    const matches = result.data.filter((entry) => entry.pullZoneId === zoneId);
    if (matches.length > 1 || (shield && matches.length)) throw new Error("Ambiguous Shield zone");
    shield ??= matches[0];
    if (!result.page.nextPage) {
      const defaults = await api<{ data: { shieldZone: unknown } }>(
        "GET",
        "/shield/shield-zone/defaults",
      );
      // Only configuration is logged, never account IDs, request data, or credentials.
      const fields = [
        "planType",
        "learningMode",
        "wafEnabled",
        "wafExecutionMode",
        "wafRequestHeaderLoggingEnabled",
        "requestBodyLoggingEnabled",
        "dDoSShieldSensitivity",
        "dDoSExecutionMode",
        "rateLimitRulesLimit",
      ];
      const pick = (input: unknown) =>
        Object.fromEntries(
          fields.map((key) => [
            key,
            input && typeof input === "object"
              ? (input as Record<string, unknown>)[key]
              : undefined,
          ]),
        );
      console.log(
        JSON.stringify({
          configured: !!shield,
          configuration: pick(shield),
          defaults: pick(defaults.data.shieldZone),
        }),
      );
      return;
    }
  }
  throw new Error("Shield discovery exceeded page limit");
}

if (import.meta.main) await inspectShield(bunnyApi(required("BUNNY_API_KEY")));
