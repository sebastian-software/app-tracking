import { readJSON, abortable } from "./json.ts";
import { failure, reply, record, sha256, TelemetryError, uuid7 } from "./contract.ts";
export interface HistoryPermissionStorage {
  setHistoryPermission(
    tool: string,
    stream: string,
    id: string,
    tokenHash: string,
    enabled: boolean,
    changedAt: number,
    signal: AbortSignal,
  ): Promise<{ result: unknown }>;
}
export function createHistoryPermissionHandler(
  storage: HistoryPermissionStorage,
  enabled = true,
  kind: "history" | "public" = "history",
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      match = (
        kind === "history"
          ? /^\/v1\/history-permissions\/(legacy|events)\/([^/]+)$/
          : /^\/v1\/public-permissions\/(legacy|events)\/([^/]+)$/
      ).exec(url.pathname),
      revision = kind === "history" ? "monthly-history-v1" : "public-usage-v1";
    if (!match) return failure("not_found");
    if (request.method !== "PUT") return failure("method_not_allowed", { Allow: "PUT" });
    if (
      url.search ||
      url.hash ||
      request.url.includes("?") ||
      request.headers.has("cookie") ||
      request.headers.has("content-encoding")
    )
      return failure("invalid_request");
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return failure("unsupported_media_type");
    const [, stream, id] = match,
      tool = request.headers.get("App-Tracking-Tool") ?? "",
      token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return failure("unauthorized");
    if (
      !["ardo", "dalo", "palamedes", "ferriki"].includes(tool) ||
      (tool === "ardo" && stream === "legacy") ||
      (stream === "legacy" ? !uuid7.test(id!) : !/^[0-9a-f]{64}$/.test(id!))
    )
      return failure("invalid_request");
    const headerBytes = [...request.headers].reduce(
      (total, [key, value]) => total + new TextEncoder().encode(key + ": " + value + "\r\n").length,
      0,
    );
    if (headerBytes > 16384) return failure("invalid_request");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
    try {
      const body = await readJSON(request, 1024, signal);
      if (
        !record(body) ||
        Object.keys(body).sort().join() !== "changed_at,enabled,revision,schema_version" ||
        body.schema_version !== 1 ||
        body.revision !== revision ||
        typeof body.enabled !== "boolean" ||
        !Number.isSafeInteger(body.changed_at) ||
        Number(body.changed_at) < 0
      )
        return failure("invalid_request");
      if (body.enabled && !enabled) return failure("not_found");
      const tokenHash = await sha256(
        stream === "legacy" ? `app-tracking-token-v1\n${id}\n${token}` : token,
      );
      const { result } = await abortable(
        storage.setHistoryPermission(
          tool,
          stream!,
          id!,
          tokenHash,
          body.enabled,
          Number(body.changed_at),
          signal,
        ),
        signal,
      );
      if (!record(result)) return failure("service_unavailable");
      if ("error" in result) {
        const code = result.error;
        if (
          code === "not_found" ||
          code === "unauthorized" ||
          code === "installation_revoked" ||
          code === "registration_conflict" ||
          code === "invalid_request"
        )
          return failure(code);
        return failure("service_unavailable");
      }
      if (
        result.status !== "updated" ||
        result.changed_at !== body.changed_at ||
        result.enabled !== body.enabled
      )
        return failure("service_unavailable");
      return reply({
        schema_version: 1,
        revision,
        changed_at: body.changed_at,
        enabled: body.enabled,
      });
    } catch (error) {
      return failure(error instanceof TelemetryError ? error.code : "service_unavailable");
    }
  };
}
