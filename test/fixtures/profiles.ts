import type { ProfileQuery, ProfileResult } from "../../src/reporting/profiles.ts";
export function profileFixture(query: ProfileQuery): ProfileResult {
  return {
    schema_version: 1,
    enabled: true,
    unit: "linked_local_profiles",
    period: { ...query, snapshot_at: new Date().toISOString() },
    totals: { profiles: "30", installations: "50", projects: "8" },
    combinations: [
      { tools: ["dalo"], profiles: "10" },
      { tools: ["dalo", "palamedes"], profiles: "20" },
    ],
  };
}
