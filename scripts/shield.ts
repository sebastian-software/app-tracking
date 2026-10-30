import { isDeepStrictEqual } from "node:util";
import { bunnyApi, required, type BunnyApi } from "./bunny.ts";

// Bunny Shield v1 enums: https://api.bunny.net/shield/docs/v1/swagger.json
// Explicit Basic avoids the provider's paid Advanced default.
export const SHIELD_SETTINGS = {
  planType: 0,
  learningMode: false,
  wafEnabled: true,
  wafExecutionMode: 1, // Block.
  wafRequestHeaderLoggingEnabled: false,
  requestBodyLoggingEnabled: false,
  dDoSShieldSensitivity: 1, // Low; never force a browser challenge for every request.
};
export const RULE_NAME = "app-tracking-api-writes-v1";
export const API_WRITE_RULE = {
  actionType: 1, // RateLimit, not Challenge.
  variableTypes: { REQUEST_URI: "" },
  operatorType: 0, // BEGINSWITH.
  value: "/v1/",
  isNegated: false,
  isRegexVariable: false,
  transformationTypes: [],
  requestCount: 120,
  counterKeyType: 0, // IP, shared across all matching paths.
  timeframe: 60,
  blockTime: 30,
  chainedRuleConditions: [
    {
      variableTypes: { REQUEST_METHOD: "" },
      operatorType: 12, // WITHIN; does not require Advanced's regex support.
      value: "POST PUT",
      isNegated: false,
      isRegexVariable: false,
    },
  ],
};
interface ShieldZone extends Record<string, unknown> {
  shieldZoneId: number;
  pullZoneId: number;
  planType: number;
  rateLimitRulesLimit: number;
}
interface Rule {
  id: number;
  shieldZoneId: number;
  ruleName: string;
  ruleConfiguration: Record<string, unknown> | null;
  ruleJson?: string | null;
}
interface Page<T> {
  data: T[] | null;
  page: { nextPage: number | null } | null;
  error?: { success: boolean };
}
async function list<T>(api: BunnyApi, path: string): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api<Page<T>>("GET", `${path}?perPage=100&page=${page}`);
    if (result.error?.success === false) throw new Error("Shield listing failed");
    if (result.data !== null && !Array.isArray(result.data))
      throw new Error("Invalid Shield listing");
    const data = result.data ?? [];
    entries.push(...data);
    // Shield returns nullable data and no pagination for an empty rule list.
    if (!data.length && !result.page) return entries;
    if (!result.page) throw new Error("Missing Shield pagination");
    if (result.page.nextPage === null) return entries;
    if (result.page.nextPage !== page + 1) throw new Error("Invalid Shield pagination");
  }
  throw new Error("Shield discovery exceeded page limit");
}
async function readZone(api: BunnyApi, pullZoneId: number) {
  const matches = (await list<ShieldZone>(api, "/shield/shield-zones")).filter(
    (zone) => zone.pullZoneId === pullZoneId,
  );
  if (matches.length > 1) throw new Error("Ambiguous Shield zone");
  return matches[0] as ShieldZone | undefined;
}
function managedRule(rules: Rule[], zone: ShieldZone) {
  if (rules.some((rule) => rule.shieldZoneId !== zone.shieldZoneId))
    throw new Error("Rate limit belongs to another Shield zone");
  const matches = rules.filter((rule) => rule.ruleName === RULE_NAME);
  if (matches.length > 1) throw new Error("Ambiguous managed Shield rate limit");
  return matches[0] as Rule | undefined;
}
function ruleConfiguration(rule: Rule | undefined): Record<string, unknown> | undefined {
  if (rule?.ruleConfiguration) return rule.ruleConfiguration;
  if (!rule?.ruleJson) return;
  try {
    const configuration: unknown = JSON.parse(rule.ruleJson);
    if (configuration && typeof configuration === "object" && !Array.isArray(configuration))
      return configuration as Record<string, unknown>;
  } catch {
    /* Do not expose a provider response in an exception. */
  }
  throw new Error("Invalid managed rate limit configuration");
}
function ruleMatches(rule: Rule | undefined) {
  const configuration = ruleConfiguration(rule);
  return (
    !!configuration &&
    Object.entries(API_WRITE_RULE).every(([key, expected]) =>
      isDeepStrictEqual(configuration[key], expected),
    )
  );
}
function settingsMatch(zone: ShieldZone) {
  return Object.entries(SHIELD_SETTINGS).every(([key, value]) => zone[key] === value);
}

export async function configureShield(api: BunnyApi, pullZoneId: number, apply = false) {
  if (!Number.isSafeInteger(pullZoneId) || pullZoneId < 1) throw new Error("Invalid pull zone");
  let zone = await readZone(api, pullZoneId);
  let changes = 0;
  if (!zone && apply) {
    await api("POST", "/shield/shield-zone", {
      pullZoneId,
      shieldZone: SHIELD_SETTINGS,
      botDetectionExecutionMode: 0, // LogOnly; the consumers are non-browser clients.
      csamScanningMode: 0,
      antivirusScanningMode: 0,
      accessLists: {},
    });
    changes++;
    zone = await readZone(api, pullZoneId);
    if (!zone) throw new Error("Shield creation was not confirmed");
  }
  if (!zone) return { configured: false, verified: false, changes };
  if (zone.planType !== 0) throw new Error("Existing paid Shield plan requires separate review");
  let rules = await list<Rule>(api, `/shield/rate-limits/${zone.shieldZoneId}`);
  let rule = managedRule(rules, zone);
  const bot = await api<{ data: { executionMode: number } | null }>(
    "GET",
    `/shield/shield-zone/${zone.shieldZoneId}/bot-detection`,
  );
  // Basic does not include bot mitigation; its endpoint returns null when unconfigured.
  if (bot.data !== null && bot.data.executionMode !== 0)
    throw new Error("Unexpected browser bot challenge configuration");
  if (apply) {
    if (!rule && rules.length >= zone.rateLimitRulesLimit)
      throw new Error("No free Shield rate limit slot; existing rules were preserved");
    if (!settingsMatch(zone)) {
      await api("PATCH", "/shield/shield-zone", {
        shieldZoneId: zone.shieldZoneId,
        shieldZone: SHIELD_SETTINGS,
      });
      changes++;
    }
    if (!ruleMatches(rule)) {
      const body = {
        ruleName: RULE_NAME,
        ruleDescription:
          "Bound POST/PUT API traffic per IP without browser challenges or limiting deletion.",
        ruleConfiguration: API_WRITE_RULE,
      };
      if (rule) await api("PATCH", `/shield/rate-limit/${rule.id}`, body);
      else await api("POST", "/shield/rate-limit", { shieldZoneId: zone.shieldZoneId, ...body });
      changes++;
    }
    // A successful write response is insufficient: read back the effective settings.
    zone = await readZone(api, pullZoneId);
    if (!zone) throw new Error("Shield zone disappeared during verification");
    rules = await list<Rule>(api, `/shield/rate-limits/${zone.shieldZoneId}`);
    rule = managedRule(rules, zone);
  }
  const verified = settingsMatch(zone) && zone.dDoSExecutionMode === 1 && ruleMatches(rule);
  if (apply && !verified)
    throw new Error(
      `Shield settings did not converge: ${JSON.stringify({
        settingsDiffer: Object.entries(SHIELD_SETTINGS)
          .filter(([key, value]) => zone[key] !== value)
          .map(([key]) => key),
        ddosBlocking: zone.dDoSExecutionMode === 1,
        rateFieldsDiffer: Object.entries(API_WRITE_RULE)
          .filter(([key, value]) => !isDeepStrictEqual(ruleConfiguration(rule)?.[key], value))
          .map(([key]) => key),
        managedRulePresent: !!rule,
        configurationFields: Object.keys(ruleConfiguration(rule) ?? {}),
      })}`,
    );
  // Log only selected configuration values, never IDs, headers, payloads, or traffic.
  return {
    configured: true,
    verified,
    changes,
    configuration: Object.fromEntries(Object.keys(SHIELD_SETTINGS).map((key) => [key, zone[key]])),
    ddosBlocking: zone.dDoSExecutionMode === 1,
    apiWritesPerMinutePerIp: ruleMatches(rule) ? API_WRITE_RULE.requestCount : null,
    botChallenges: false,
    rateLimitCount: rules.length,
    ...(!verified
      ? {
          managedRulePresent: !!rule,
          configurationFields: Object.keys(ruleConfiguration(rule) ?? {}),
        }
      : {}),
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
