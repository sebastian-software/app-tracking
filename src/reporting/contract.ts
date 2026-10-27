export interface UsageQuery {
  from: string;
  until: string;
  tool: "all" | "dalo" | "palamedes";
  mode: "local" | "ci";
}
export interface UsageResult {
  schema_version: 1;
  period: { from: string; until: string; covered_from: string; snapshot_at: string };
  scope: { tool: UsageQuery["tool"]; mode: UsageQuery["mode"] };
  coverage: {
    retained_from: string;
    clipped: boolean;
    provisional_from: string;
    has_observations: boolean;
    versions_truncated: boolean;
  };
  totals: {
    invocations: string;
    active_installations: string;
    active_projects: string;
    unknown_project_invocations: string;
  };
  daily: {
    day: string;
    invocations: string;
    active_installations: string;
    active_projects: string;
  }[];
  commands: { tool_id: string; command: string; invocations: string }[];
  versions: { tool_id: string; tool_version: string; invocations: string }[];
}
export function utcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function usageQuery(url: URL): UsageQuery {
  for (const key of url.searchParams.keys()) {
    if (
      !["from", "until", "tool", "mode"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new Error("invalid_request");
  }
  const from = url.searchParams.get("from") ?? "";
  const until = url.searchParams.get("until") ?? "";
  const tool = url.searchParams.get("tool") ?? "all";
  const mode = url.searchParams.get("mode") ?? "local";
  const days = (Date.parse(until) - Date.parse(from)) / 86_400_000;
  if (
    !utcDay(from) ||
    !utcDay(until) ||
    days < 1 ||
    days > 90 ||
    !["all", "dalo", "palamedes"].includes(tool) ||
    !["local", "ci"].includes(mode)
  )
    throw new Error("invalid_request");
  return { from, until, tool, mode } as UsageQuery;
}

export function checkedUsage(value: unknown, query: UsageQuery): UsageResult {
  function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid reporting result");
    return input as Record<string, unknown>;
  }
  function text(input: unknown, max = 128): string {
    if (typeof input !== "string" || input.length < 1 || input.length > max)
      throw new Error("Invalid reporting result");
    return input;
  }
  function count(input: unknown): string {
    const result = text(input, 40);
    if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error("Invalid reporting count");
    return result;
  }
  function date(input: unknown): string {
    const result = text(input, 10);
    if (!utcDay(result)) throw new Error("Invalid reporting day");
    return result;
  }
  function boolean(input: unknown): boolean {
    if (typeof input !== "boolean") throw new Error("Invalid reporting flag");
    return input;
  }
  function array(input: unknown, max: number): Record<string, unknown>[] {
    if (!Array.isArray(input) || input.length > max) throw new Error("Invalid reporting rows");
    return input.map(record);
  }
  const result = record(value),
    period = record(result.period),
    scope = record(result.scope),
    coverage = record(result.coverage),
    totals = record(result.totals);
  if (
    result.schema_version !== 1 ||
    scope.tool !== query.tool ||
    scope.mode !== query.mode ||
    period.from !== query.from ||
    period.until !== query.until ||
    !Number.isFinite(Date.parse(text(period.snapshot_at)))
  )
    throw new Error("Invalid reporting scope");
  return {
    schema_version: 1,
    period: {
      from: query.from,
      until: query.until,
      covered_from: date(period.covered_from),
      snapshot_at: text(period.snapshot_at),
    },
    scope: { tool: query.tool, mode: query.mode },
    coverage: {
      retained_from: date(coverage.retained_from),
      clipped: boolean(coverage.clipped),
      provisional_from: date(coverage.provisional_from),
      has_observations: boolean(coverage.has_observations),
      versions_truncated: boolean(coverage.versions_truncated),
    },
    totals: {
      invocations: count(totals.invocations),
      active_installations: count(totals.active_installations),
      active_projects: count(totals.active_projects),
      unknown_project_invocations: count(totals.unknown_project_invocations),
    },
    daily: array(result.daily, 90).map((row) => ({
      day: date(row.day),
      invocations: count(row.invocations),
      active_installations: count(row.active_installations),
      active_projects: count(row.active_projects),
    })),
    commands: array(result.commands, 200).map((row) => ({
      tool_id: text(row.tool_id, 32),
      command: text(row.command, 32),
      invocations: count(row.invocations),
    })),
    versions: array(result.versions, 100).map((row) => ({
      tool_id: text(row.tool_id, 32),
      tool_version: text(row.tool_version),
      invocations: count(row.invocations),
    })),
  };
}

export const privateHeaders = {
  Vary: "Cookie",
  "Cache-Control": "private, no-store",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export function adminReply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}
