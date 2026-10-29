import { profileQuery, checkedProfiles } from "./profiles.ts";
import { historyQuery, checkedHistory, checkedPublicUsage } from "./history.ts";
import { eventQuery, checkedEvents } from "./events.ts";
import { adminReply, checkedUsage, privateHeaders, utcDay, usageQuery } from "./contract.ts";
import type { ReportingStorage } from "./storage.ts";
import { reportingFailureLabel } from "./storage.ts";
import { adminHTML, adminCSS, adminJS } from "./view.ts";
import type { ReportingAuth } from "./auth.ts";
import { serviceQuery, checkedServiceRequests } from "./service-requests.ts";

export function createReportingHandler(storage: () => ReportingStorage, auth: ReportingAuth) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/public/usage") {
      const headers = {
        "Cache-Control": "no-store",
        "CDN-Cache-Control": "no-store",
        "Surrogate-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      if (request.method !== "GET" || url.search)
        return Response.json({ error: "invalid_request" }, { status: 400, headers });
      try {
        const result = await storage().publicUsage?.(
          AbortSignal.any([request.signal, AbortSignal.timeout(2800)]),
        );
        if (result && "error" in result && result.error === "not_found")
          return Response.json({ error: "not_found" }, { status: 404, headers });
        return Response.json(checkedPublicUsage(result), { headers });
      } catch {
        return Response.json({ error: "service_unavailable" }, { status: 503, headers });
      }
    }
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
    const isProfiles = url.pathname === "/v1/admin/profiles";
    const isHistory = url.pathname === "/v1/admin/history";
    const isEvents = url.pathname === "/v1/admin/events";
    const isService = url.pathname === "/v1/admin/service-requests";
    if (!isService && !isProfiles && !isHistory && !isEvents && url.pathname !== "/v1/admin/usage")
      return adminReply({ error: "not_found" }, 404);
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
      query = isService
        ? { kind: "service" as const, value: serviceQuery(url) }
        : isProfiles
          ? { kind: "profiles" as const, value: profileQuery(url) }
          : isHistory
            ? { kind: "history" as const, value: historyQuery(url) }
            : isEvents
              ? { kind: "events" as const, value: eventQuery(url) }
              : { kind: "usage" as const, value: usageQuery(url) };
    } catch {
      return reply({ error: "invalid_request" }, 400);
    }
    let stage = "storage";
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(2800)]);
      const database = storage();
      const result =
        query.kind === "service"
          ? await database.serviceRequests?.(query.value, signal)
          : query.kind === "profiles"
            ? await database.profiles?.(query.value, signal)
            : query.kind === "history"
              ? await database.history?.(query.value, signal)
              : query.kind === "events"
                ? await database.events?.(query.value, signal)
                : await database.usage(query.value, signal);
      stage = "contract";
      if (!result || typeof result !== "object") throw new Error("Invalid reporting result");
      if ("error" in result) {
        if (
          result.error === "outside_retention" &&
          "retained_from" in result &&
          typeof result.retained_from === "string" &&
          utcDay(result.retained_from)
        )
          return reply({ error: "outside_retention", retained_from: result.retained_from }, 422);
        if (result.error === "invalid_request") return reply({ error: "invalid_request" }, 400);
        throw new Error("Reporting operation failed");
      }
      return reply(
        query.kind === "service"
          ? checkedServiceRequests(result, query.value)
          : query.kind === "profiles"
            ? checkedProfiles(result, query.value)
            : query.kind === "history"
              ? checkedHistory(result, query.value)
              : query.kind === "events"
                ? checkedEvents(result, query.value)
                : checkedUsage(result, query.value),
      );
    } catch (error) {
      const response = reply({ error: "service_unavailable" }, 503);
      response.headers.set(
        "X-App-Tracking-Reporting-Failure",
        stage + ":" + reportingFailureLabel(error),
      );
      return response;
    }
  };
}
