import { adminReply, checkedUsage, privateHeaders, utcDay, usageQuery } from "./contract.ts";
import type { ReportingStorage } from "./storage.ts";
import { adminHTML, adminCSS, adminJS } from "./view.ts";

export async function adminTokenHash(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`app-tracking-admin-v1\n${token}`),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function equalHash(a: string, b: string): boolean {
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export function createReportingHandler(storage: () => ReportingStorage, hashes: string[]) {
  if (hashes.length < 1 || hashes.length > 8 || hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)))
    throw new Error("Reporting credential configuration is invalid");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const assets = new Map([
      ["/admin", [adminHTML, "text/html; charset=utf-8"]],
      ["/admin/style.css", [adminCSS, "text/css; charset=utf-8"]],
      ["/admin/app.js", [adminJS, "text/javascript; charset=utf-8"]],
    ]);
    const asset = assets.get(url.pathname);
    if (asset && request.method === "GET" && !url.search)
      return new Response(asset[0], { headers: { ...privateHeaders, "Content-Type": asset[1] } });
    if (url.pathname !== "/v1/admin/usage") return adminReply({ error: "not_found" }, 404);
    if (request.method !== "GET") return adminReply({ error: "method_not_allowed" }, 405);
    if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
      return adminReply({ error: "forbidden" }, 403);
    const token = /^Bearer (at_admin_v1_[0-9a-f]{64})$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (!token) {
      return adminReply({ error: "unauthorized" }, 401);
    }
    const hash = await adminTokenHash(token);
    let authorized = false;
    for (const allowed of hashes) authorized = equalHash(hash, allowed) || authorized;
    if (!authorized) return adminReply({ error: "unauthorized" }, 401);
    let query;
    try {
      query = usageQuery(url);
    } catch {
      return adminReply({ error: "invalid_request" }, 400);
    }
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(2800)]);
      const result = await storage().usage(query, signal);
      if (!result || typeof result !== "object") throw new Error("Invalid reporting result");
      if ("error" in result) {
        if (
          result.error === "outside_retention" &&
          result.retained_from &&
          utcDay(result.retained_from)
        )
          return adminReply(
            { error: "outside_retention", retained_from: result.retained_from },
            422,
          );
        if (result.error === "invalid_request")
          return adminReply({ error: "invalid_request" }, 400);
        throw new Error("Reporting operation failed");
      }
      return adminReply(checkedUsage(result, query));
    } catch {
      return adminReply({ error: "service_unavailable" }, 503);
    }
  };
}
