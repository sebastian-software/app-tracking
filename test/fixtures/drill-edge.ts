// Synthetic staging-only deployment. Never published to production or retained
// as a promotable release artifact.
import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createHandler } from "../../src/handler.ts";
declare const __APP_REVISION__: string;
const versionPath = "/v1/versions/dalo/npm/stable";
BunnySDK.net.http.serve(async (request) => {
  const path = new URL(request.url).pathname;
  let now = Date.now();
  let failing = false;
  const handle = createHandler({
    now: () => now,
    retryDelayMs: 0,
    fetch: async () => {
      if (failing) return new Response(null, { status: 503 });
      return Response.json({
        name: "getdalo",
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": { name: "getdalo", version: "1.2.3" } },
        time: { "1.2.3": new Date(now - 1000).toISOString() },
      });
    },
  });
  const inner = new Request(new URL(versionPath, request.url));
  if (path === "/health")
    return Response.json(
      { status: "ok" },
      { headers: { "X-App-Revision": __APP_REVISION__ + "-drill", "Cache-Control": "no-store" } },
    );
  if (
    !["/probe/fresh", "/probe/purge", "/probe/stale", "/probe/expired", "/probe/cold"].includes(
      path,
    )
  )
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (path !== "/probe/cold") await (await handle(inner)).body?.cancel();
  if (path !== "/probe/fresh" && path !== "/probe/purge") {
    failing = true;
    now += path === "/probe/expired" ? 86_400_000 : 3_600_000;
  }
  const result = await handle(inner);
  result.headers.set("X-App-Revision", __APP_REVISION__ + "-drill");
  result.headers.set("X-Probe-Origin", crypto.randomUUID());
  if (path === "/probe/fresh")
    result.headers.set("Cache-Control", "public, max-age=0, s-maxage=2, must-revalidate");
  if (path === "/probe/purge")
    result.headers.set("Cache-Control", "public, max-age=0, s-maxage=600, must-revalidate");
  return result;
});
