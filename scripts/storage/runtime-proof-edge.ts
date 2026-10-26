import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createService } from "../../src/service.ts";
import { createTelemetryService } from "../../src/telemetry/service.ts";
declare const __APP_REVISION__: string;
const deno = (
  globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }
).Deno;
function env(name: string) {
  const value = deno?.env.get(name) ?? globalThis.process?.env?.[name];
  if (!value) throw new Error("Synthetic runtime configuration missing");
  return value;
}
const token = env("PROOF_AUTH_TOKEN");
let telemetry: ReturnType<typeof createTelemetryService> | undefined;
const service = createService(
  () => (telemetry ??= createTelemetryService(env("PROOF_DATABASE_URL"))),
);
BunnySDK.net.http.serve(async (request) => {
  const path = new URL(request.url).pathname;
  const privateRoute = path === "/v1/usage-batches" || /^\/v1\/installations\//.test(path);
  const provided = request.headers.get("X-App-Tracking-Proof") ?? "";
  let difference = provided.length ^ token.length;
  for (let n = 0; n < token.length; n++)
    difference |= token.charCodeAt(n) ^ (provided.charCodeAt(n) || 0);
  const response =
    !privateRoute || difference === 0
      ? await service(request)
      : Response.json(
          { error: { code: "not_found" } },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
  response.headers.set("X-App-Revision", __APP_REVISION__);
  return response;
});
