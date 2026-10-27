import schema from "../../contracts/telemetry-v1.schema.json" with { type: "json" };
import catalog from "../../contracts/event-catalog.json" with { type: "json" };
import { canonical, failure, record, reply, sha256, statuses, TelemetryError } from "./contract.ts";
import { abortable, readJSON, readEmptyBody } from "./json.ts";

export type EventCatalog = Record<
  string,
  Record<
    string,
    {
      collection: string;
      dimensions: Record<string, string[]>;
      system: string;
      project?: boolean;
    }
  >
>;
export interface EventBatch {
  schema_version: 1;
  tool_id: string;
  batch_id: string;
  collection: "opt_in" | "opt_out";
  mode: "local" | "ci";
  installation_id?: string;
  consented_at?: number;
  rows: Record<string, unknown>[];
}
export interface EventStorage {
  submitEvents(
    batch: EventBatch,
    hash: string,
    tokenHash: string | null,
    signal: AbortSignal,
  ): Promise<{ result: unknown }>;
  deleteEvents(
    tool: string,
    id: string,
    tokenHash: string,
    signal: AbortSignal,
  ): Promise<{ result: unknown }>;
}
const hex = /^[0-9a-f]{64}$/;
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new TelemetryError("invalid_request");
}
function system(value: unknown, profile: string): boolean {
  if (profile === "none") return value === undefined;
  if (!record(value)) return false;
  if (
    !["arch,cpu_family,os,os_version", "arch,cpu_family,linux,os,os_version"].includes(
      Object.keys(value).sort().join(),
    )
  )
    return false;
  if (value.linux !== undefined) {
    if (
      profile !== "full" ||
      value.os !== "linux" ||
      !record(value.linux) ||
      Object.keys(value.linux).sort().join() !==
        "distribution,distribution_version,kernel_version" ||
      ![
        "ubuntu",
        "debian",
        "fedora",
        "arch",
        "alpine",
        "nixos",
        "rhel",
        "centos",
        "rocky",
        "opensuse",
        "linuxmint",
        "pop",
        "other",
        "unknown",
      ].includes(String(value.linux.distribution)) ||
      ![value.linux.distribution_version, value.linux.kernel_version].every(
        (v) => typeof v === "string" && /^(unknown|\d{1,5}(?:\.\d{1,5}){0,3})$/.test(v),
      )
    )
      return false;
  }
  if (typeof value.os !== "string" || typeof value.arch !== "string") return false;
  return (
    ["macos", "linux", "windows", "other"].includes(String(value.os)) &&
    ["aarch64", "x86_64", "x86", "arm", "other"].includes(String(value.arch)) &&
    typeof value.os_version === "string" &&
    /^(unknown|\d{1,5}(?:\.\d{1,5}){0,3})$/.test(value.os_version) &&
    typeof value.cpu_family === "string" &&
    /^(unknown|other|intel|amd|apple_m[1-9])$/.test(value.cpu_family) &&
    (profile !== "platform" || (value.os_version === "unknown" && value.cpu_family === "unknown"))
  );
}
export function eventBatch(input: unknown, definitions: EventCatalog = catalog.tools): EventBatch {
  if (!record(input)) throw new TelemetryError("invalid_request");
  keys(
    input,
    ["schema_version", "tool_id", "batch_id", "collection", "mode", "rows"],
    ["installation_id", "consented_at"],
  );
  if (input.schema_version !== 1) throw new TelemetryError("unsupported_schema");
  if (typeof input.tool_id !== "string" || !Object.hasOwn(definitions, input.tool_id))
    throw new TelemetryError("unsupported_tool");
  if (
    typeof input.batch_id !== "string" ||
    !hex.test(input.batch_id) ||
    !["opt_in", "opt_out"].includes(String(input.collection)) ||
    !["local", "ci"].includes(String(input.mode))
  )
    throw new TelemetryError("invalid_request");
  if (input.collection === "opt_in") {
    if (
      typeof input.installation_id !== "string" ||
      !hex.test(input.installation_id) ||
      !Number.isSafeInteger(input.consented_at) ||
      Number(input.consented_at) < 0
    )
      throw new TelemetryError("consent_required");
  } else if (Object.hasOwn(input, "installation_id") || Object.hasOwn(input, "consented_at"))
    throw new TelemetryError("invalid_request");
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 64)
    throw new TelemetryError("invalid_request");
  const seen = new Set<string>();
  let total = 0;
  for (const row of input.rows) {
    if (!record(row)) throw new TelemetryError("invalid_request");
    keys(
      row,
      ["day", "metric", "collection", "tool_version", "dimensions", "count"],
      ["system", "project_id", "project_id_version"],
    );
    if (typeof row.metric !== "string" || !Object.hasOwn(definitions[input.tool_id], row.metric))
      throw new TelemetryError("invalid_request");
    const definition = definitions[input.tool_id][row.metric];
    if (
      definition.collection !== input.collection ||
      row.collection !== input.collection ||
      !Number.isSafeInteger(row.day) ||
      Number(row.day) < 0 ||
      Number(row.day) > 2932896 ||
      typeof row.tool_version !== "string" ||
      row.tool_version.length > 128 ||
      !new RegExp(schema.$defs.row.properties.tool_version.pattern).test(row.tool_version) ||
      !Number.isSafeInteger(row.count) ||
      Number(row.count) < 1 ||
      Number(row.count) > 1000000 ||
      !record(row.dimensions) ||
      !system(row.system, definition.system)
    )
      throw new TelemetryError("invalid_request");
    if (
      Object.hasOwn(row, "project_id") !== Object.hasOwn(row, "project_id_version") ||
      (Object.hasOwn(row, "project_id") &&
        (input.collection !== "opt_in" ||
          !definition.project ||
          typeof row.project_id !== "string" ||
          !hex.test(row.project_id) ||
          row.project_id_version !== 1))
    )
      throw new TelemetryError("invalid_request");
    const values = row.dimensions;
    if (
      Object.keys(values).length !== Object.keys(definition.dimensions).length ||
      Object.entries(definition.dimensions).some(
        ([key, allowed]) =>
          typeof values[key] !== "string" || !allowed.includes(values[key] as string),
      )
    )
      throw new TelemetryError("invalid_request");
    const { count: _, ...dimensions } = row;
    const key = canonical(dimensions);
    if (seen.has(key)) throw new TelemetryError("duplicate_dimensions");
    seen.add(key);
    total += Number(row.count);
  }
  if (total > 10000000) throw new TelemetryError("count_limit");
  return input as unknown as EventBatch;
}

function outcome(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new TelemetryError("service_unavailable");
  if (typeof value.error === "string" && Object.hasOwn(statuses, value.error))
    throw new TelemetryError(value.error as keyof typeof statuses);
  return value;
}

export function createEventHandler(
  storage: EventStorage,
  definitions: EventCatalog = catalog.tools,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const deleting = /^\/v1\/event-installations\/([0-9a-f]{64})$/.exec(url.pathname);
      if (url.pathname !== "/v1/event-batches" && !deleting) return failure("not_found");
      if (
        url.search ||
        url.hash ||
        request.url.includes("?") ||
        request.url.includes("#") ||
        request.headers.has("cookie")
      )
        return failure("invalid_request");
      if (request.method !== (deleting ? "DELETE" : "POST")) return failure("method_not_allowed");
      let size = 0;
      for (const [key, value] of request.headers)
        size += new TextEncoder().encode(`${key}: ${value}\r\n`).length;
      if (size > 16384 || request.headers.has("content-encoding"))
        return failure("invalid_request");
      const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
      if (deleting) {
        const tool = request.headers.get("App-Tracking-Tool") ?? "";
        if (!token || !Object.hasOwn(definitions, tool)) return failure("unauthorized");
        await readEmptyBody(request, signal);
        const result = outcome(
          (
            await abortable(
              storage.deleteEvents(tool, deleting[1], await sha256(token), signal),
              signal,
            )
          ).result,
        );
        if (result.status === "pending") return reply({ status: "pending" }, 202);
        if (result.status !== "deleted") throw new TelemetryError("service_unavailable");
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        )
      )
        return failure("unsupported_media_type");
      const batch = eventBatch(await readJSON(request, 60000, signal), definitions);
      if (batch.collection === "opt_in" ? !token : request.headers.has("authorization"))
        return failure("unauthorized");
      const hash = await sha256(canonical(batch));
      const result = outcome(
        (
          await abortable(
            storage.submitEvents(batch, hash, token ? await sha256(token) : null, signal),
            signal,
          )
        ).result,
      );
      if (result.status !== "accepted" && result.status !== "duplicate")
        throw new TelemetryError("service_unavailable");
      return reply({ batch_id: batch.batch_id, payload_sha256: hash }, 200);
    } catch (error) {
      return failure(error instanceof TelemetryError ? error.code : "service_unavailable");
    }
  };
}
