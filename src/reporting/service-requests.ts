import { catalog } from "../catalog.ts";
import { utcDay } from "./contract.ts";
import { record } from "../telemetry/contract.ts";

export interface ServiceQuery {
  from: string;
  until: string;
  tool: "all" | "dalo" | "palamedes";
}
export interface ServiceRequestResult {
  schema_version: 1;
  period: { from: string; until: string; covered_from: string };
  scope: { tool: ServiceQuery["tool"] };
  coverage: { unit: "origin_version_requests"; retained_from: string; clipped: boolean };
  rows: {
    day: string;
    tool_id: string;
    distribution: string;
    channel: string;
    status: number;
    count: string;
  }[];
}
export function serviceQuery(url: URL): ServiceQuery {
  for (const key of url.searchParams.keys()) {
    if (!["from", "until", "tool"].includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error("invalid_request");
  }
  const from = url.searchParams.get("from") ?? "";
  const until = url.searchParams.get("until") ?? "";
  const tool = url.searchParams.get("tool") ?? "all";
  const days = (Date.parse(until) - Date.parse(from)) / 86_400_000;
  if (
    !utcDay(from) ||
    !utcDay(until) ||
    days < 1 ||
    days > 90 ||
    !["all", "dalo", "palamedes"].includes(tool)
  )
    throw new Error("invalid_request");
  return { from, until, tool } as ServiceQuery;
}
export function checkedServiceRequests(value: unknown, query: ServiceQuery): ServiceRequestResult {
  const invalid = () => new Error("Invalid service statistics");
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    !record(value.period) ||
    !record(value.scope) ||
    !record(value.coverage) ||
    value.period.from !== query.from ||
    value.period.until !== query.until ||
    value.scope.tool !== query.tool ||
    typeof value.period.covered_from !== "string" ||
    !utcDay(value.period.covered_from) ||
    value.period.covered_from < query.from ||
    value.period.covered_from >= query.until ||
    value.coverage.unit !== "origin_version_requests" ||
    typeof value.coverage.retained_from !== "string" ||
    !utcDay(value.coverage.retained_from) ||
    typeof value.coverage.clipped !== "boolean" ||
    value.period.covered_from !==
      (query.from < value.coverage.retained_from ? value.coverage.retained_from : query.from) ||
    value.coverage.clipped !== (value.period.covered_from !== query.from) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 1350
  )
    throw invalid();
  const seen = new Set<string>();
  const coveredFrom = value.period.covered_from;
  const rows = value.rows.map((row) => {
    if (
      !record(row) ||
      typeof row.day !== "string" ||
      !utcDay(row.day) ||
      row.day < coveredFrom ||
      row.day >= query.until ||
      !catalog.some(
        (c) =>
          c.tool === row.tool_id &&
          c.distribution === row.distribution &&
          c.channel === row.channel,
      ) ||
      (query.tool !== "all" && row.tool_id !== query.tool) ||
      ![200, 304, 503].includes(Number(row.status)) ||
      typeof row.status !== "number" ||
      typeof row.count !== "string" ||
      !/^[1-9][0-9]{0,12}$/.test(row.count) ||
      BigInt(row.count) > 1000000000000n
    )
      throw invalid();
    const key = JSON.stringify([row.day, row.tool_id, row.distribution, row.channel, row.status]);
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return {
      day: row.day,
      tool_id: String(row.tool_id),
      distribution: String(row.distribution),
      channel: String(row.channel),
      status: row.status,
      count: row.count,
    };
  });
  return {
    schema_version: 1,
    period: { from: query.from, until: query.until, covered_from: value.period.covered_from },
    scope: { tool: query.tool },
    coverage: {
      unit: "origin_version_requests",
      retained_from: value.coverage.retained_from,
      clipped: value.coverage.clipped,
    },
    rows,
  };
}
