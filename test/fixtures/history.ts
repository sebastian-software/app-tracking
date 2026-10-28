import type {
  HistoryQuery,
  HistoryResult,
  PublicUsageResult,
} from "../../src/reporting/history.ts";
export function historyFixture(query: HistoryQuery): HistoryResult {
  const months: HistoryResult["months"] = [];
  const tools =
    query.tool === "all"
      ? query.stream === "legacy"
        ? ["dalo", "palamedes"]
        : query.metric === "cli.invocation"
          ? ["dalo", "palamedes"]
          : ["ferriki"]
      : [query.tool];
  const date = new Date(query.from + "T00:00:00Z");
  let index = 0;
  while (date.toISOString().slice(0, 10) < query.until) {
    const month = date.toISOString().slice(0, 10);
    for (const tool of tools) {
      const state = index % 4 === 0 ? "incomplete" : index % 4 === 1 ? "suppressed" : "finalized";
      months.push({
        month,
        tool_id: tool,
        state,
        reason:
          state === "incomplete" ? "source_expired" : state === "suppressed" ? "cohort" : "ready",
        data:
          state !== "finalized"
            ? null
            : {
                count: "240",
                monthly_installations: "24",
                monthly_projects: "20",
                breakdowns: [
                  {
                    dimension: "version_family",
                    value: "2.0",
                    count: "240",
                    monthly_installations: "24",
                    monthly_projects: "20",
                  },
                ],
                suppressed_breakdowns: ["command"],
              },
      });
    }
    date.setUTCMonth(date.getUTCMonth() + 1);
    index++;
  }
  return {
    schema_version: 1,
    enabled: true,
    retention_months: 24,
    period: {
      from: query.from,
      until: query.until,
      snapshot_at: new Date().toISOString(),
      coverage_from: query.from,
    },
    scope: { tool: query.tool, stream: query.stream, metric: query.metric, mode: query.mode },
    months,
  };
}
export function publicUsageFixture(): PublicUsageResult {
  return {
    schema_version: 1,
    unit: "reported_observations",
    window: "complete_utc_months",
    count_rounding: 10,
    snapshot_at: new Date().toISOString(),
    series: [
      {
        month: "2026-09-01",
        tool_id: "palamedes",
        stream: "legacy",
        metric: "cli.invocation",
        mode: "local",
        state: "available",
        count: "240",
      },
    ],
  };
}
