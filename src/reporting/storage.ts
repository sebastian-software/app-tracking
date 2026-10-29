import type { ProfileQuery, ProfileResult } from "./profiles.ts";
import type { HistoryQuery, HistoryResult, PublicUsageResult } from "./history.ts";
import { neon } from "@neondatabase/serverless";
// Import the shared driver configuration without constructing ingestion storage.
import "../storage/database.ts";
import type { UsageQuery, UsageResult } from "./contract.ts";
import type { EventQuery, EventResult } from "./events.ts";
import type { ServiceQuery, ServiceRequestResult } from "./service-requests.ts";

export interface ReportingStorage {
  serviceRequests?(
    query: ServiceQuery,
    signal: AbortSignal,
  ): Promise<ServiceRequestResult | { error: string; retained_from?: string }>;
  profiles?(
    query: ProfileQuery,
    signal: AbortSignal,
  ): Promise<ProfileResult | { error: string; retained_from?: string }>;
  history?(query: HistoryQuery, signal: AbortSignal): Promise<HistoryResult | { error: string }>;
  publicUsage?(signal: AbortSignal): Promise<PublicUsageResult | { error: string }>;
  events?(
    query: EventQuery,
    signal: AbortSignal,
  ): Promise<EventResult | { error: string; retained_from?: string }>;
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
  "configuration",
  "configuration_protocol",
  "configuration_host",
  "configuration_credentials",
  "configuration_fragment",
  "configuration_tls",
  "configuration_override",
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
  // Provider-generated PostgreSQL URLs may include native TLS options. HTTPS
  // fetch already verifies the endpoint certificate; keep those options out of
  // the HTTP proxy's connection startup parameters.
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new ReportingStorageError("configuration_protocol");
  if (!parsed.hostname.endsWith(".pg.psdb.cloud"))
    throw new ReportingStorageError("configuration_host");
  if (!parsed.username || !parsed.password)
    throw new ReportingStorageError("configuration_credentials");
  if (parsed.hash) throw new ReportingStorageError("configuration_fragment");
  if (
    [
      "host",
      "hostname",
      "port",
      "database",
      "user",
      "username",
      "password",
      "connectionString",
    ].some((key) => parsed.searchParams.has(key))
  )
    throw new ReportingStorageError("configuration_override");
  if (
    parsed.searchParams
      .getAll("sslmode")
      .some((value) => ["disable", "allow", "prefer"].includes(value))
  )
    throw new ReportingStorageError("configuration_tls");
  parsed.protocol = "postgresql:";
  parsed.search = "";
  const sql = neon(parsed.href);
  async function aggregate(queryText: string, params: string[], signal: AbortSignal) {
    const trace: { subrequests: number; responseStatus?: number } = { subrequests: 0 };
    try {
      const result = await sql.query(queryText, params, {
        fetchOptions: { signal, redirect: "error", cache: "no-store", appTrackingTrace: trace },
      });
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
  }
  return {
    serviceRequests: (query, signal) =>
      aggregate(
        "SELECT app_tracking.admin_service_requests_v1($1::date,$2::date,$3) AS result",
        [query.from, query.until, query.tool],
        signal,
      ),
    profiles: (query, signal) =>
      aggregate(
        "SELECT app_tracking.admin_profiles_v1($1::date,$2::date) AS result",
        [query.from, query.until],
        signal,
      ),
    history: (query, signal) =>
      aggregate(
        "SELECT app_tracking.admin_history_v1($1::date,$2::date,$3,$4,$5,$6) AS result",
        [query.from, query.until, query.tool, query.stream, query.metric, query.mode],
        signal,
      ),
    publicUsage: (signal) =>
      aggregate("SELECT app_tracking.public_usage_v1() AS result", [], signal),
    usage: (query, signal) =>
      aggregate(
        "SELECT app_tracking.admin_usage_v1($1::date,$2::date,$3,$4) AS result",
        [query.from, query.until, query.tool, query.mode],
        signal,
      ),
    events: (query, signal) =>
      aggregate(
        "SELECT app_tracking.admin_events_v1($1::date,$2::date,$3,$4,$5) AS result",
        [query.from, query.until, query.tool, query.mode, query.metric],
        signal,
      ),
  };
}
