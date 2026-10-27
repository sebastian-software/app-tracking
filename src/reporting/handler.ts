import { adminReply, checkedUsage, privateHeaders, utcDay, usageQuery } from "./contract.ts";
import type { ReportingStorage } from "./storage.ts";
import { adminHTML, adminCSS, adminJS } from "./view.ts";
import type { ReportingAuth } from "./auth.ts";

export function createReportingHandler(storage: () => ReportingStorage, auth: ReportingAuth) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const authResponse = await auth.route(request);
    if (authResponse) return authResponse;
    const assets = new Map([
      ["/admin", [adminHTML, "text/html; charset=utf-8"]],
      ["/admin/style.css", [adminCSS, "text/css; charset=utf-8"]],
      ["/admin/app.js", [adminJS, "text/javascript; charset=utf-8"]],
    ]);
    const asset = assets.get(url.pathname);
    const loginMessage = url.pathname === "/admin" && /^\?auth=(failed|denied)$/.test(url.search);
    if (asset && request.method === "GET" && (!url.search || loginMessage))
      return new Response(asset[0], { headers: { ...privateHeaders, "Content-Type": asset[1] } });
    if (url.pathname !== "/v1/admin/usage") return adminReply({ error: "not_found" }, 404);
    if (request.method !== "GET") return adminReply({ error: "method_not_allowed" }, 405);
    if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
      return adminReply({ error: "forbidden" }, 403);
    const access = await auth.check(request);
    if ("response" in access) return access.response;
    const authHeaders = access.headers;
    function reply(body: unknown, status = 200) {
      const response = adminReply(body, status);
      for (const value of authHeaders.getSetCookie()) response.headers.append("Set-Cookie", value);
      return response;
    }
    let query;
    try {
      query = usageQuery(url);
    } catch {
      return reply({ error: "invalid_request" }, 400);
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
          return reply({ error: "outside_retention", retained_from: result.retained_from }, 422);
        if (result.error === "invalid_request") return reply({ error: "invalid_request" }, 400);
        throw new Error("Reporting operation failed");
      }
      return reply(checkedUsage(result, query));
    } catch {
      return reply({ error: "service_unavailable" }, 503);
    }
  };
}
