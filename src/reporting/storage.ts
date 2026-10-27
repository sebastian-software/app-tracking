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
const failureLabels = [
  "42501",
  "57014",
  "42883",
  "42P01",
  "42703",
  "22P02",
  "22023",
  "P0001",
  "XX000",
  "http_400",
  "http_401",
  "http_403",
  "http_404",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
  "timeout",
  "aborted",
  "network",
];
class ReportingStorageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Reporting storage failed");
    this.code = code;
  }
}
export function reportingFailureLabel(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && failureLabels.includes(code) ? code : "unavailable";
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
      const trace: { subrequests: number; responseStatus?: number } = { subrequests: 0 };
      try {
        const result = await sql.query(
          "SELECT app_tracking.admin_usage_v1($1::date,$2::date,$3,$4) AS result",
          [query.from, query.until, query.tool, query.mode],
          {
            fetchOptions: { signal, redirect: "error", cache: "no-store", appTrackingTrace: trace },
          },
        );
        return result[0]?.result;
      } catch (error) {
        const code = reportingFailureLabel(error);
        const source =
          error && typeof error === "object" && "sourceError" in error ? error.sourceError : error;
        const name =
          source && typeof source === "object" && "name" in source ? source.name : undefined;
        const label =
          code !== "unavailable"
            ? code
            : trace.responseStatus && trace.responseStatus >= 400
              ? "http_" + trace.responseStatus
              : name === "TimeoutError"
                ? "timeout"
                : name === "AbortError"
                  ? "aborted"
                  : name === "TypeError"
                    ? "network"
                    : "unavailable";
        throw new ReportingStorageError(failureLabels.includes(label) ? label : "unavailable");
      }
    },
  };
}
