import type { UsageQuery, UsageResult } from "../../src/reporting/contract.ts";
export const fixtureKey = `at_admin_v1_${"a".repeat(64)}`;
export function usageFixture(query: UsageQuery): UsageResult {
  const daily: UsageResult["daily"] = [];
  for (let time = Date.parse(query.from); time < Date.parse(query.until); time += 86400000) {
    const i = daily.length;
    daily.push({
      day: new Date(time).toISOString().slice(0, 10),
      invocations: String(300 + i * 27 + (i % 5) * 91),
      active_installations: String(160 + (i % 113)),
      active_projects: String(80 + (i % 29)),
    });
  }
  const weight = daily.reduce((total, row) => total + Number(row.invocations), 0);
  let assigned = 0;
  for (let i = 0; i < daily.length; i++) {
    const row = daily[i]!;
    const count =
      i === daily.length - 1
        ? 23514 - assigned
        : Math.floor((Number(row.invocations) * 23514) / weight);
    row.invocations = String(count);
    assigned += count;
  }
  if (daily.length === 1) {
    daily[0]!.active_installations = "312";
    daily[0]!.active_projects = "146";
  }
  return {
    schema_version: 1,
    period: {
      from: query.from,
      until: query.until,
      covered_from: query.from,
      snapshot_at: new Date().toISOString(),
    },
    scope: { tool: query.tool, mode: query.mode },
    coverage: {
      retained_from: query.from,
      clipped: false,
      provisional_from: query.from,
      has_observations: true,
      versions_truncated: false,
    },
    totals: {
      invocations: "23514",
      active_installations: "312",
      active_projects: "146",
      unknown_project_invocations: "894",
    },
    daily,
    commands: [
      { tool_id: "palamedes", command: "extract", invocations: "11350" },
      { tool_id: "palamedes", command: "lint", invocations: "6000" },
      { tool_id: "dalo", command: "sync", invocations: "6164" },
    ],
    versions: [
      { tool_id: "palamedes", tool_version: "2.0.0", invocations: "17350" },
      { tool_id: "dalo", tool_version: "1.10.0", invocations: "6164" },
    ],
  };
}
