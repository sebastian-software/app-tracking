import { neon } from "@neondatabase/serverless";
// Import the shared driver configuration without constructing ingestion storage.
import "../storage/database.ts";
import type { UsageQuery, UsageResult } from "./contract.ts";

export interface ReportingStorage {
  usage(
    query: UsageQuery,
    signal: AbortSignal,
  ): Promise<UsageResult | { error: string; retained_from?: string }>;
}
export function createReportingStorage(url: string): ReportingStorage {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "postgresql:" ||
    !parsed.hostname.endsWith(".pg.psdb.cloud") ||
    !parsed.username ||
    !parsed.password ||
    parsed.hash ||
    parsed.search
  )
    throw new Error("Reporting storage configuration is invalid");
  const sql = neon(url);
  return {
    async usage(query, signal) {
      const result = await sql.query(
        "SELECT app_tracking.admin_usage_v1($1::date,$2::date,$3,$4) AS result",
        [query.from, query.until, query.tool, query.mode],
        { fetchOptions: { signal, redirect: "error", cache: "no-store" } },
      );
      return result[0]?.result;
    },
  };
}
