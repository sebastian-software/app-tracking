import { utcDay } from "./contract.ts";
import { eventMetrics } from "./events.ts";
export interface HistoryQuery {
  from: string;
  until: string;
  tool: "all" | "ardo" | "dalo" | "palamedes" | "ferriki";
  stream: "legacy" | "events";
  metric: (typeof eventMetrics)[number];
  mode: "local" | "ci";
}
export interface HistoryCell {
  dimension: string;
  value: string;
  count: string;
  monthly_installations: string;
  monthly_projects: string;
}
export interface HistoryData {
  count: string;
  monthly_installations: string;
  monthly_projects: string;
  breakdowns: HistoryCell[];
  suppressed_breakdowns: string[];
}
export interface HistoryResult {
  schema_version: 1;
  enabled: boolean;
  retention_months: 24;
  period: { from: string; until: string; snapshot_at: string; coverage_from: string | null };
  scope: Pick<HistoryQuery, "tool" | "stream" | "metric" | "mode">;
  months: {
    month: string;
    tool_id: string;
    state: string;
    reason: string;
    data: HistoryData | null;
  }[];
}
export interface PublicUsageResult {
  schema_version: 1;
  unit: "reported_observations";
  window: "complete_utc_months";
  count_rounding: 10;
  snapshot_at: string;
  series: {
    month: string;
    tool_id: string;
    stream: string;
    metric: string;
    mode: string;
    state: "available" | "unavailable";
    count: string | null;
  }[];
}
export function historyQuery(url: URL): HistoryQuery {
  for (const key of url.searchParams.keys())
    if (
      !["from", "until", "tool", "stream", "metric", "mode"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new Error("invalid_request");
  const from = url.searchParams.get("from") ?? "",
    until = url.searchParams.get("until") ?? "";
  const tool = url.searchParams.get("tool") ?? "all",
    stream = url.searchParams.get("stream") ?? "legacy",
    metric = url.searchParams.get("metric") ?? "cli.invocation",
    mode = url.searchParams.get("mode") ?? "local";
  const months =
    (Number(until.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(until.slice(5, 7)) -
    Number(from.slice(5, 7));
  if (
    !utcDay(from) ||
    !utcDay(until) ||
    !from.endsWith("-01") ||
    !until.endsWith("-01") ||
    months < 1 ||
    months > 24 ||
    !["all", "ardo", "dalo", "palamedes", "ferriki"].includes(tool) ||
    !["legacy", "events"].includes(stream) ||
    !["local", "ci"].includes(mode) ||
    !eventMetrics.some((m) => m === metric) ||
    (stream === "legacy" && (["ardo", "ferriki"].includes(tool) || metric !== "cli.invocation"))
  )
    throw new Error("invalid_request");
  return { from, until, tool, stream, metric, mode } as HistoryQuery;
}
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid history object");
  return input as Record<string, unknown>;
};
const text = (input: unknown, max = 128) => {
  if (typeof input !== "string" || !input.length || input.length > max)
    throw new Error("Invalid history text");
  return input;
};
const count = (input: unknown) => {
  const value = text(input, 40);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid history count");
  return value;
};
const month = (input: unknown) => {
  const value = text(input, 10);
  if (!utcDay(value) || !value.endsWith("-01")) throw new Error("Invalid history month");
  return value;
};
const array = (input: unknown, max: number) => {
  if (!Array.isArray(input) || input.length > max) throw new Error("Invalid history rows");
  return input;
};
const tool = (input: unknown) => {
  const value = text(input, 32);
  if (!["ardo", "dalo", "palamedes", "ferriki"].includes(value))
    throw new Error("Invalid history tool");
  return value;
};
const timestamp = (input: unknown) => {
  const value = text(input);
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid history snapshot");
  return value;
};
const dimensions = ["command", "version_family", "kind", "language", "source"];
const dimension = (input: unknown) => {
  const value = text(input, 32);
  if (!dimensions.includes(value)) throw new Error("Invalid history dimension");
  return value;
};
export function checkedHistory(input: unknown, query: HistoryQuery): HistoryResult {
  const value = object(input),
    period = object(value.period),
    scope = object(value.scope);
  if (
    value.schema_version !== 1 ||
    value.retention_months !== 24 ||
    typeof value.enabled !== "boolean" ||
    period.from !== query.from ||
    period.until !== query.until ||
    scope.tool !== query.tool ||
    scope.stream !== query.stream ||
    scope.metric !== query.metric ||
    scope.mode !== query.mode
  )
    throw new Error("Invalid history scope");
  const seen = new Set<string>();
  return {
    schema_version: 1,
    enabled: value.enabled,
    retention_months: 24,
    period: {
      from: query.from,
      until: query.until,
      snapshot_at: timestamp(period.snapshot_at),
      coverage_from: period.coverage_from === null ? null : month(period.coverage_from),
    },
    scope: { tool: query.tool, stream: query.stream, metric: query.metric, mode: query.mode },
    months: array(value.months, 96).map((input) => {
      const row = object(input),
        key = month(row.month) + ":" + tool(row.tool_id),
        state = text(row.state, 32),
        reason = text(row.reason, 32);
      if (
        seen.has(key) ||
        String(row.month) < query.from ||
        String(row.month) >= query.until ||
        (query.tool !== "all" && row.tool_id !== query.tool) ||
        !["pending", "finalized", "suppressed", "incomplete", "expired", "disabled"].includes(
          state,
        ) ||
        ![
          "ready",
          "cohort",
          "source_expired",
          "coverage_gap",
          "deletion",
          "recovery",
          "disabled",
          "expired",
          "late_arrival",
          "missing_finalizer",
        ].includes(reason)
      )
        throw new Error("Invalid history period");
      seen.add(key);
      if ((state === "finalized") !== (row.data !== null))
        throw new Error("Invalid history visibility");
      let data: HistoryData | null = null;
      if (row.data !== null) {
        const source = object(row.data);
        if (
          BigInt(count(source.monthly_installations)) < 20n ||
          BigInt(count(source.monthly_projects)) < 20n
        )
          throw new Error("Invalid history cohort");
        data = {
          count: count(source.count),
          monthly_installations: count(source.monthly_installations),
          monthly_projects: count(source.monthly_projects),
          breakdowns: array(source.breakdowns, 500).map((input) => {
            const cell = object(input);
            if (
              BigInt(count(cell.monthly_installations)) < 20n ||
              BigInt(count(cell.monthly_projects)) < 20n
            )
              throw new Error("Invalid history cohort");
            return {
              dimension: dimension(cell.dimension),
              value: text(cell.value),
              count: count(cell.count),
              monthly_installations: count(cell.monthly_installations),
              monthly_projects: count(cell.monthly_projects),
            };
          }),
          suppressed_breakdowns: array(source.suppressed_breakdowns, 5).map(dimension),
        };
      }
      return { month: month(row.month), tool_id: tool(row.tool_id), state, reason, data };
    }),
  };
}
export function checkedPublicUsage(input: unknown): PublicUsageResult {
  const value = object(input);
  if (
    value.schema_version !== 1 ||
    value.unit !== "reported_observations" ||
    value.window !== "complete_utc_months" ||
    value.count_rounding !== 10
  )
    throw new Error("Invalid public usage contract");
  const seen = new Set<string>();
  return {
    schema_version: 1,
    unit: "reported_observations",
    window: "complete_utc_months",
    count_rounding: 10,
    snapshot_at: timestamp(value.snapshot_at),
    // Seven registered stream/metric pairs, two contexts, 24 retained months.
    series: array(value.series, 336).map((input) => {
      const row = object(input),
        start = month(row.month),
        tool_id = tool(row.tool_id),
        stream = text(row.stream, 16),
        metric = text(row.metric, 64),
        mode = text(row.mode, 8),
        state = text(row.state, 16);
      const key = [start, tool_id, stream, metric, mode].join(":");
      if (
        seen.has(key) ||
        !["legacy", "events"].includes(stream) ||
        !eventMetrics.some((m) => m === metric) ||
        !["local", "ci"].includes(mode) ||
        !["available", "unavailable"].includes(state) ||
        (state === "available") !== (row.count !== null)
      )
        throw new Error("Invalid public usage series");
      seen.add(key);
      const total = row.count === null ? null : count(row.count);
      if (total !== null && BigInt(total) % 10n !== 0n)
        throw new Error("Invalid public usage rounding");
      return {
        month: start,
        tool_id,
        stream,
        metric,
        mode,
        state: state as "available" | "unavailable",
        count: total,
      };
    }),
  };
}
