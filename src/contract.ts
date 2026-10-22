export interface Release {
  latest_version: string;
  published_at: string;
  release_url: string;
}

export interface VersionResponse extends Release {
  schema_version: 1;
  tool_id: string;
  distribution: string;
  channel: string;
  checked_at: string;
  stale: boolean;
}

export type ErrorCode =
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "unknown_tool"
  | "unsupported_distribution"
  | "unsupported_channel"
  | "release_unavailable";

export function errorResponse(status: number, code: ErrorCode): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (status === 405) headers.Allow = "GET";
  if (status === 503) headers["Retry-After"] = "60";
  return Response.json({ schema_version: 1, error: { code } }, { status, headers });
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Stable SemVer only: no coercion of "v1", leading zeroes, or prereleases.
export function stableVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  );
}

export function timestamp(value: unknown, now: number): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 300_000) return undefined;
  const normalized = new Date(time).toISOString();
  return normalized === (value.includes(".") ? value : value.replace("Z", ".000Z"))
    ? normalized
    : undefined;
}
