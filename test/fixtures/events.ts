import type { EventQuery, EventResult } from "../../src/reporting/events.ts";

export function eventFixture(query: EventQuery): EventResult {
  const daily: EventResult["daily"] = [];
  for (let time = Date.parse(query.from); time < Date.parse(query.until); time += 86400000) {
    daily.push({
      day: new Date(time).toISOString().slice(0, 10),
      count: "12",
      active_installations: "2",
      active_projects: "1",
    });
  }
  const count = String(daily.length * 12);
  const tool =
    query.tool !== "all" ? query.tool : query.metric === "cli.invocation" ? "palamedes" : "ferriki";
  return {
    schema_version: 1,
    period: {
      from: query.from,
      until: query.until,
      covered_from: query.from,
      snapshot_at: new Date().toISOString(),
    },
    scope: { tool: query.tool, mode: query.mode, metric: query.metric },
    coverage: {
      retained_from: query.from,
      clipped: false,
      provisional_from: query.from,
      has_observations: true,
      versions_truncated: false,
      dimensions_truncated: false,
      systems_truncated: false,
    },
    totals: { count, active_installations: "2", active_projects: "1", unknown_project_count: "0" },
    daily,
    versions: [{ tool_id: tool, tool_version: "2.0.0", count }],
    dimensions:
      query.metric === "language.use"
        ? [
            { tool_id: tool, dimension: "language", value: "rust", count },
            {
              tool_id: tool,
              dimension: "source",
              value: "explicit",
              count: String(daily.length * 8),
            },
            {
              tool_id: tool,
              dimension: "source",
              value: "dependency",
              count: String(daily.length * 4),
            },
          ]
        : [
            {
              tool_id: tool,
              dimension: query.metric === "cli.invocation" ? "command" : "kind",
              value: query.metric === "cli.invocation" ? "extract" : "grammar",
              count,
            },
          ],
    systems: [
      { dimension: "os", value: "linux", count },
      { dimension: "cpu_family", value: "unknown", count },
      { dimension: "linux_distribution", value: "ubuntu", count },
    ],
  };
}
