import schema from "../../contracts/telemetry-v1.schema.json" with { type: "json" };
import policy from "../../contracts/telemetry-v1-policy.json" with { type: "json" };
import type { UsageRow } from "../storage/database.ts";

export { policy };
export const uuid7 = new RegExp(schema.$defs.uuid7.pattern);
export interface Registration {
  schema_version: 1;
  tool_id: string;
  consent_revision: string;
  consented_at: string;
  mode: "local" | "ci";
}
export interface Batch {
  schema_version: 1;
  tool_id: string;
  installation_id: string;
  batch_id: string;
  consent_revision: string;
  rows: UsageRow[];
}
export const statuses = {
  invalid_request: 400,
  unsupported_schema: 400,
  unsupported_tool: 400,
  invalid_usage_day: 400,
  batch_expired: 400,
  clock_skew: 400,
  duplicate_dimensions: 400,
  count_limit: 400,
  unauthorized: 401,
  installation_not_found: 404,
  not_found: 404,
  registration_conflict: 409,
  batch_conflict: 409,
  consent_required: 409,
  installation_expired: 410,
  installation_revoked: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  method_not_allowed: 405,
  rate_limited: 429,
  service_unavailable: 503,
} as const;
export type ErrorCode = keyof typeof statuses;
export class TelemetryError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super("Telemetry operation failed");
    this.code = code;
  }
}
export function reply(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}
export function failure(code: ErrorCode, headers: Record<string, string> = {}) {
  return reply({ schema_version: 1, error: { code } }, statuses[code], {
    ...(["rate_limited", "service_unavailable"].includes(code) ? { "Retry-After": "60" } : {}),
    ...headers,
  });
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new TelemetryError("invalid_request");
}
function envelope(value: unknown): asserts value is Record<string, unknown> & {
  schema_version: 1;
  tool_id: string;
  consent_revision: string;
} {
  if (!record(value)) throw new TelemetryError("invalid_request");
  if (value.schema_version !== 1) throw new TelemetryError("unsupported_schema");
  if (typeof value.tool_id !== "string" || !Object.hasOwn(policy.tools, value.tool_id))
    throw new TelemetryError("unsupported_tool");
  // Revision decisions happen after authentication inside the database transaction.
  if (
    typeof value.consent_revision !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(value.consent_revision)
  )
    throw new TelemetryError("invalid_request");
}
function realDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function registration(value: unknown): Registration {
  envelope(value);
  keys(value, ["schema_version", "tool_id", "consent_revision", "consented_at", "mode"]);
  if (
    typeof value.consented_at !== "string" ||
    !new RegExp(schema.$defs.timestamp.pattern).test(value.consented_at) ||
    !realDate(value.consented_at.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value.consented_at)) ||
    new Date(value.consented_at).toISOString() !== value.consented_at ||
    (value.mode !== "local" && value.mode !== "ci")
  )
    throw new TelemetryError("invalid_request");
  return {
    schema_version: 1,
    tool_id: value.tool_id,
    consent_revision: value.consent_revision,
    consented_at: value.consented_at,
    mode: value.mode,
  };
}
const semver = new RegExp(schema.$defs.row.properties.tool_version.pattern);
export function batch(value: unknown): Batch {
  envelope(value);
  keys(value, [
    "schema_version",
    "tool_id",
    "installation_id",
    "batch_id",
    "consent_revision",
    "rows",
  ]);
  if (
    typeof value.installation_id !== "string" ||
    !uuid7.test(value.installation_id) ||
    typeof value.batch_id !== "string" ||
    !uuid7.test(value.batch_id) ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > policy.max_rows
  )
    throw new TelemetryError("invalid_request");
  const dimensions = new Set<string>();
  const rows: UsageRow[] = [];
  for (const row of value.rows) {
    if (!record(row)) throw new TelemetryError("invalid_request");
    keys(row, ["day", "tool_version", "command", "count"], ["project_id", "project_id_version"]);
    if (!realDate(row.day)) throw new TelemetryError("invalid_usage_day");
    if (
      typeof row.tool_version !== "string" ||
      row.tool_version.length > 128 ||
      !semver.test(row.tool_version) ||
      typeof row.command !== "string" ||
      !/^[a-z]{1,32}$/.test(row.command) ||
      Object.hasOwn(row, "project_id") !== Object.hasOwn(row, "project_id_version") ||
      (Object.hasOwn(row, "project_id") &&
        (typeof row.project_id !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.project_id) ||
          row.project_id_version !== 1))
    )
      throw new TelemetryError("invalid_request");
    if (
      typeof row.count !== "number" ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      row.count > policy.max_row_count
    )
      throw new TelemetryError("count_limit");
    const key = dimensionKey(row);
    if (dimensions.has(key)) throw new TelemetryError("duplicate_dimensions");
    dimensions.add(key);
    rows.push({
      day: row.day,
      tool_version: row.tool_version,
      command: row.command,
      count: row.count,
      ...(typeof row.project_id === "string"
        ? { project_id: row.project_id, project_id_version: 1 }
        : {}),
    });
  }
  // Catalog and total/day quota checks follow retained-receipt lookup in SQL.
  return {
    schema_version: 1,
    tool_id: value.tool_id,
    installation_id: value.installation_id,
    batch_id: value.batch_id,
    consent_revision: value.consent_revision,
    rows,
  };
}
// JCS for the validated ASCII-string / safe-integer v1 domain, not arbitrary JSON.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function dimensionKey(row: object): string {
  const { count: _, ...dimensions } = row as Record<string, unknown>;
  return canonical(dimensions);
}
export function canonicalBatch(value: Batch): string {
  const rows = [...value.rows].sort((a, b) => {
    const left = dimensionKey(a),
      right = dimensionKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return canonical({ ...value, rows });
}
export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join("");
}
