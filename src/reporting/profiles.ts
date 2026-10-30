import { usageQuery, type UsageQuery } from "./contract.ts";
export type ProfileQuery = Pick<UsageQuery, "from" | "until">;
export interface ProfileResult {
  schema_version: 1;
  enabled: boolean;
  unit: "linked_local_profiles";
  period: { from: string; until: string; snapshot_at: string };
  totals: { profiles: string; installations: string; projects: string };
  combinations: { tools: string[]; profiles: string }[];
}
export function profileQuery(url: URL): ProfileQuery {
  if ([...url.searchParams.keys()].some((key) => !["from", "until"].includes(key)))
    throw new Error("invalid_request");
  const { from, until } = usageQuery(url);
  return { from, until };
}
export function checkedProfiles(input: unknown, query: ProfileQuery): ProfileResult {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid profile response");
    return value as Record<string, unknown>;
  };
  const count = (value: unknown): string => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,39})$/.test(value))
      throw new Error("Invalid profile count");
    return value;
  };
  const value = object(input),
    period = object(value.period),
    totals = object(value.totals);
  if (
    value.schema_version !== 1 ||
    typeof value.enabled !== "boolean" ||
    value.unit !== "linked_local_profiles" ||
    period.from !== query.from ||
    period.until !== query.until ||
    typeof period.snapshot_at !== "string" ||
    !Number.isFinite(Date.parse(period.snapshot_at)) ||
    !Array.isArray(value.combinations) ||
    value.combinations.length > 15
  )
    throw new Error("Invalid profile contract");
  const seen = new Set<string>();
  const combinations = value.combinations.map((input): ProfileResult["combinations"][number] => {
    const row = object(input),
      tools = row.tools;
    if (
      !Array.isArray(tools) ||
      tools.length < 1 ||
      tools.length > 4 ||
      tools.some((tool) => !["ardo", "dalo", "ferriki", "palamedes"].includes(tool)) ||
      new Set(tools).size !== tools.length ||
      tools.join(":") !== [...tools].sort().join(":")
    )
      throw new Error("Invalid profile combination");
    const key = tools.join(":");
    if (seen.has(key)) throw new Error("Duplicate profile combination");
    seen.add(key);
    return { tools, profiles: count(row.profiles) };
  });
  const profiles = count(totals.profiles),
    installations = count(totals.installations),
    projects = count(totals.projects);
  if (
    combinations.reduce((sum, row) => sum + BigInt(row.profiles), 0n) !== BigInt(profiles) ||
    BigInt(installations) < BigInt(profiles) ||
    (!value.enabled &&
      (profiles !== "0" || installations !== "0" || projects !== "0" || combinations.length))
  )
    throw new Error("Invalid profile totals");
  return {
    schema_version: 1,
    enabled: value.enabled,
    unit: "linked_local_profiles",
    period: { from: query.from, until: query.until, snapshot_at: period.snapshot_at },
    totals: { profiles, installations, projects },
    combinations,
  };
}
