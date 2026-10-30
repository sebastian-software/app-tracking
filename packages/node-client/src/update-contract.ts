/** Update protocol logic. Times use whole Unix seconds, as in the Rust client. */
export const UPDATE_NETWORK_BUDGET_MS = 200;
export const HOUR = 3600;
export const DAY = 86_400;
const SKEW = 300;

export type UpdateMode = "enabled" | "disabled" | "offline";
export interface UpdateClientOptions {
  origin: string;
  /** Absolute private cache root, scoped to this service endpoint. */
  cacheRoot: string;
  tool: string;
  version: string;
  distribution: string;
  channel?: string;
  /** False sends DNT: 1 without disabling functional checks. */
  serviceMetrics?: boolean;
}
export interface Update {
  latestVersion: string;
  releaseUrl: string;
  stale: boolean;
}
export type UpdateErrorCode =
  | "Configuration"
  | "Cache"
  | "Network"
  | "HttpStatus"
  | "InvalidResponse"
  | "Cancelled";
const messages: Record<UpdateErrorCode, string> = {
  Configuration: "invalid update-check configuration",
  Cache: "update cache unavailable",
  Network: "update request failed or exceeded its deadline",
  HttpStatus: "update service returned an unsuccessful HTTP status",
  InvalidResponse: "invalid update response",
  Cancelled: "update check cancelled",
};
export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly status?: number;
  constructor(code: UpdateErrorCode, status?: number) {
    super(messages[code]);
    this.name = "UpdateError";
    this.code = code;
    this.status = status;
  }
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UpdateError("Cancelled");
}
interface Version {
  core: bigint[];
  pre: string[];
}
export function version(raw: unknown): Version | undefined {
  if (typeof raw !== "string") return;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      raw,
    );
  if (!match || match[0] !== raw) return;
  const core = match.slice(1, 4).map(BigInt);
  const pre = match[4]?.split(".") ?? [];
  if (core.some((n) => n > 18_446_744_073_709_551_615n) || pre.some((p) => /^0[0-9]+$/.test(p)))
    return;
  return { core, pre };
}
export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i],
      right = b.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^[0-9]+$/.test(left),
      rn = /^[0-9]+$/.test(right);
    if (ln !== rn) return ln ? -1 : 1;
    if (ln && left.length !== right.length) return left.length > right.length ? 1 : -1;
    return left > right ? 1 : -1;
  }
  return 0;
}
function timestamp(raw: unknown): number | undefined {
  if (typeof raw !== "string") return;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.[0-9]+)?Z$/.exec(raw);
  if (!m || m[0] !== raw) return;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  // RFC 3339 permits a leap second; time's Rust parser maps it to second 59.
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59)));
  if (
    year < 1970 ||
    second > 60 ||
    !Number.isFinite(+date) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  )
    return;
  if (
    second === 60 &&
    (hour !== 23 || minute !== 59 || day !== new Date(Date.UTC(year, month, 0)).getUTCDate())
  )
    return;
  return Math.floor(+date / 1000);
}
export interface Release {
  schema_version: number;
  tool_id: string;
  distribution: string;
  channel: string;
  latest_version: string;
  published_at: string;
  release_url: string;
  checked_at: string;
  stale: boolean;
}
export interface UpdateState {
  schema_version: 1;
  resource: string;
  next_check: number;
  failures: number;
  release: Release | null;
  etag: string | null;
  noticed_version: string | null;
  noticed_at: number;
}
export function empty(resource: string): UpdateState {
  return {
    schema_version: 1,
    resource,
    next_check: 0,
    failures: 0,
    release: null,
    etag: null,
    noticed_version: null,
    noticed_at: 0,
  };
}
export function defer(state: UpdateState, now: number): void {
  state.failures = Math.min(state.failures + 1, 5);
  state.next_check = now + Math.min(300 * 2 ** (state.failures - 1), HOUR);
}
export function validEtag(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length <= 256 &&
    /^(?:W\/)?"[\x21\x23-\x7e]*"$/.exec(raw)?.[0] === raw
  );
}
export function releaseShape(raw: unknown): raw is Release {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return (
    Number.isInteger(r.schema_version) &&
    Number(r.schema_version) >= 0 &&
    Number(r.schema_version) <= 0xffff_ffff &&
    typeof r.stale === "boolean" &&
    [
      "tool_id",
      "distribution",
      "channel",
      "latest_version",
      "published_at",
      "release_url",
      "checked_at",
    ].every((key) => typeof r[key] === "string")
  );
}
export function releaseFields(r: Release): Release {
  return {
    schema_version: r.schema_version,
    tool_id: r.tool_id,
    distribution: r.distribution,
    channel: r.channel,
    latest_version: r.latest_version,
    published_at: r.published_at,
    release_url: r.release_url,
    checked_at: r.checked_at,
    stale: r.stale,
  };
}
export function release(raw: unknown, tool: UpdateClientOptions, now: number): Release {
  if (!releaseShape(raw)) throw new UpdateError("InvalidResponse");
  const r = raw as Release;
  const v = version(r.latest_version),
    checked = timestamp(r.checked_at),
    published = timestamp(r.published_at);
  let url: URL;
  try {
    url = new URL(r.release_url);
  } catch {
    throw new UpdateError("InvalidResponse");
  }
  if (
    r.schema_version !== 1 ||
    r.tool_id !== tool.tool ||
    r.distribution !== tool.distribution ||
    r.channel !== (tool.channel ?? "stable") ||
    !v ||
    v.pre.length ||
    typeof r.stale !== "boolean" ||
    typeof r.release_url !== "string" ||
    !/^https:\/\/[^/]/.test(r.release_url) ||
    /[^\x21-\x7e]|\\/.test(r.release_url) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[#\x00-\x1f\x7f-\x9f]/.test(r.release_url) ||
    checked === undefined ||
    published === undefined ||
    checked > now + SKEW ||
    published > checked + SKEW ||
    now - checked >= DAY
  )
    throw new UpdateError("InvalidResponse");
  return releaseFields(r);
}
export function freshResponse(r: Release, now: number): void {
  if (!r.stale && now - timestamp(r.checked_at)! >= HOUR + SKEW)
    throw new UpdateError("InvalidResponse");
}
export function notice(
  state: UpdateState,
  tool: UpdateClientOptions,
  now: number,
): Update | undefined {
  let r: Release;
  try {
    r = release(state.release, tool, now);
  } catch {
    return;
  }
  const latest = version(r.latest_version)!;
  if (compare(latest, version(tool.version)!) <= 0) return;
  const previous = version(state.noticed_version);
  if (previous && compare(latest, previous) <= 0 && now - state.noticed_at < DAY) return;
  state.noticed_version = r.latest_version;
  state.noticed_at = now;
  return {
    latestVersion: r.latest_version,
    releaseUrl: r.release_url,
    stale: r.stale || now - timestamp(r.checked_at)! >= HOUR,
  };
}
