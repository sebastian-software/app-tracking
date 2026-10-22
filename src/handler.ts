import { catalog } from "./catalog.ts";
import { errorResponse, type VersionResponse } from "./contract.ts";
import { createResolver, FRESH_SECONDS, MAX_AGE_SECONDS } from "./resolver.ts";
import type { UpstreamOptions } from "./upstream.ts";

export function createHandler(options: Partial<UpstreamOptions> = {}) {
  const now = options.now ?? Date.now;
  const resolve = createResolver({ ...options, fetch: options.fetch ?? fetch, now });

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
    const url = new URL(request.url);
    if (
      request.url.includes("?") ||
      url.hash ||
      request.body !== null ||
      (request.headers.has("content-length") && request.headers.get("content-length") !== "0") ||
      request.headers.has("transfer-encoding")
    )
      return errorResponse(400, "invalid_request");
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
    }
    const route =
      /^\/v1\/versions\/([a-z][a-z0-9-]{0,63})\/([a-z][a-z0-9-]{0,31})\/([a-z][a-z0-9-]{0,31})$/.exec(
        url.pathname,
      );
    if (!route) return errorResponse(404, "not_found");
    const [, tool, distribution, channel] = route;
    const toolEntries = catalog.filter((entry) => entry.tool === tool);
    if (!toolEntries.length) return errorResponse(404, "unknown_tool");
    const distributions = toolEntries.filter((entry) => entry.distribution === distribution);
    if (!distributions.length) return errorResponse(404, "unsupported_distribution");
    const entry = distributions.find((entry) => entry.channel === channel);
    if (!entry) return errorResponse(404, "unsupported_channel");
    const checked = await resolve(entry);
    const ageMs = checked ? now() - checked.checkedAt : Infinity;
    if (!checked || ageMs < 0 || ageMs >= MAX_AGE_SECONDS * 1_000) {
      return errorResponse(503, "release_unavailable");
    }
    const stale = ageMs >= FRESH_SECONDS * 1_000;
    const payload: VersionResponse = {
      schema_version: 1,
      tool_id: entry.tool,
      distribution: entry.distribution,
      channel: entry.channel,
      ...checked.release,
      checked_at: new Date(checked.checkedAt).toISOString(),
      stale,
    };
    const body = JSON.stringify(payload);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const etag = `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
    const remaining = Math.max(0, Math.floor((FRESH_SECONDS * 1_000 - ageMs) / 1_000));
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": stale
        ? "no-store"
        : `public, max-age=0, s-maxage=${remaining}, must-revalidate`,
      ETag: etag,
    };
    const validators = request.headers
      .get("if-none-match")
      ?.split(",")
      .map((value) => value.trim());
    if (validators?.some((value) => value === "*" || value.replace(/^W\//, "") === etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  };
}
