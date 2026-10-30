import { utcDay } from "./contract.ts";

export const eventMetrics = ["cli.invocation", "resource.download", "language.use"] as const;
export const systemFields = [
  "os",
  "os_version",
  "arch",
  "cpu_family",
  "linux_distribution",
  "linux_distribution_version",
  "linux_kernel_version",
] as const;
export const dimensionFields = ["command", "kind", "language", "source"] as const;
export interface EventQuery {
  from: string;
  until: string;
  tool: "all" | "ardo" | "dalo" | "palamedes" | "ferriki";
  mode: "local" | "ci";
  metric: (typeof eventMetrics)[number];
}
export interface EventResult {
  schema_version: 1;
  period: { from: string; until: string; covered_from: string; snapshot_at: string };
  scope: Pick<EventQuery, "tool" | "mode" | "metric">;
  coverage: {
    retained_from: string;
    clipped: boolean;
    provisional_from: string;
    has_observations: boolean;
    versions_truncated: boolean;
    dimensions_truncated: boolean;
    systems_truncated: boolean;
  };
  totals: {
    count: string;
    active_installations: string;
    active_projects: string;
    unknown_project_count: string;
  };
  daily: { day: string; count: string; active_installations: string; active_projects: string }[];
  versions: { tool_id: string; tool_version: string; count: string }[];
  dimensions: { tool_id: string; dimension: string; value: string; count: string }[];
  systems: { dimension: string; value: string; count: string }[];
}

export function eventQuery(url: URL): EventQuery {
  for (const key of url.searchParams.keys()) {
    if (
      !["from", "until", "tool", "mode", "metric"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new Error("invalid_request");
  }
  const from = url.searchParams.get("from") ?? "",
    until = url.searchParams.get("until") ?? "";
  const tool = url.searchParams.get("tool") ?? "all",
    mode = url.searchParams.get("mode") ?? "local";
  const metric = url.searchParams.get("metric") ?? "cli.invocation";
  const days = (Date.parse(until) - Date.parse(from)) / 86400000;
  if (
    !utcDay(from) ||
    !utcDay(until) ||
    days < 1 ||
    days > 90 ||
    !["all", "ardo", "dalo", "palamedes", "ferriki"].includes(tool) ||
    !["local", "ci"].includes(mode) ||
    !eventMetrics.some((value) => value === metric)
  )
    throw new Error("invalid_request");
  return { from, until, tool, mode, metric } as EventQuery;
}

// Reconstruct only the aggregate contract; never forward database rows or IDs.
export function checkedEvents(value: unknown, query: EventQuery): EventResult {
  const obj = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid event result");
    return input as Record<string, unknown>;
  };
  const text = (input: unknown, max = 128): string => {
    if (typeof input !== "string" || !input.length || input.length > max)
      throw new Error("Invalid event text");
    return input;
  };
  const count = (input: unknown): string => {
    const result = text(input, 40);
    if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error("Invalid event count");
    return result;
  };
  const date = (input: unknown): string => {
    const result = text(input, 10);
    if (!utcDay(result)) throw new Error("Invalid event date");
    return result;
  };
  const flag = (input: unknown): boolean => {
    if (typeof input !== "boolean") throw new Error("Invalid event flag");
    return input;
  };
  const rows = (input: unknown, max: number) => {
    if (!Array.isArray(input) || input.length > max) throw new Error("Invalid event rows");
    return input.map(obj);
  };
  const tool = (input: unknown) => {
    const result = text(input, 32);
    if (
      !["ardo", "dalo", "palamedes", "ferriki"].includes(result) ||
      (query.tool !== "all" && query.tool !== result)
    )
      throw new Error("Invalid event tool");
    return result;
  };
  const result = obj(value),
    period = obj(result.period),
    scope = obj(result.scope),
    coverage = obj(result.coverage),
    totals = obj(result.totals);
  const snapshot = text(period.snapshot_at);
  if (
    result.schema_version !== 1 ||
    period.from !== query.from ||
    period.until !== query.until ||
    scope.tool !== query.tool ||
    scope.mode !== query.mode ||
    scope.metric !== query.metric ||
    !Number.isFinite(Date.parse(snapshot))
  )
    throw new Error("Invalid event scope");
  const retained = date(coverage.retained_from),
    covered = date(period.covered_from);
  if (covered !== (query.from > retained ? query.from : retained) || covered >= query.until)
    throw new Error("Invalid event coverage");
  const daily = rows(result.daily, 90).map((row) => ({
    day: date(row.day),
    count: count(row.count),
    active_installations: count(row.active_installations),
    active_projects: count(row.active_projects),
  }));
  if (
    daily.length !== (Date.parse(query.until) - Date.parse(covered)) / 86400000 ||
    daily.some(
      (row, i) =>
        row.day !== new Date(Date.parse(covered) + i * 86400000).toISOString().slice(0, 10),
    )
  )
    throw new Error("Invalid event daily coverage");
  const totalCount = count(totals.count),
    unknown = count(totals.unknown_project_count);
  if (
    BigInt(unknown) > BigInt(totalCount) ||
    daily.reduce((sum, row) => sum + BigInt(row.count), 0n) !== BigInt(totalCount)
  )
    throw new Error("Invalid event totals");
  return {
    schema_version: 1,
    period: { from: query.from, until: query.until, covered_from: covered, snapshot_at: snapshot },
    scope: { tool: query.tool, mode: query.mode, metric: query.metric },
    coverage: {
      retained_from: retained,
      clipped: flag(coverage.clipped),
      provisional_from: date(coverage.provisional_from),
      has_observations: flag(coverage.has_observations),
      versions_truncated: flag(coverage.versions_truncated),
      dimensions_truncated: flag(coverage.dimensions_truncated),
      systems_truncated: flag(coverage.systems_truncated),
    },
    totals: {
      count: totalCount,
      active_installations: count(totals.active_installations),
      active_projects: count(totals.active_projects),
      unknown_project_count: unknown,
    },
    daily,
    versions: rows(result.versions, 100).map((row) => ({
      tool_id: tool(row.tool_id),
      tool_version: text(row.tool_version),
      count: count(row.count),
    })),
    dimensions: rows(result.dimensions, 400).map((row) => {
      const dimension = text(row.dimension, 32);
      if (!dimensionFields.some((field) => field === dimension))
        throw new Error("Invalid event dimension");
      return {
        tool_id: tool(row.tool_id),
        dimension,
        value: text(row.value),
        count: count(row.count),
      };
    }),
    systems: rows(result.systems, 700).map((row) => {
      const dimension = text(row.dimension, 32);
      if (!systemFields.some((field) => field === dimension))
        throw new Error("Invalid system dimension");
      return { dimension, value: text(row.value), count: count(row.count) };
    }),
  };
}
