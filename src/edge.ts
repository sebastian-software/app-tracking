import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createService } from "./service.ts";
import { createTelemetryService } from "./telemetry/service.ts";
import { createReportingService } from "./reporting/service.ts";
declare const __APP_REVISION__: string;
const deno = (
  globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }
).Deno;
const env = (name: string) => deno?.env.get(name) ?? globalThis.process?.env?.[name];
let telemetry: ReturnType<typeof createTelemetryService> | undefined;
let reporting: ReturnType<typeof createReportingService> | undefined;
const handle = createService(
  () => {
    if (env("APP_TRACKING_TELEMETRY_ENABLED") !== "1") return undefined;
    const url = env("APP_TRACKING_DATABASE_URL");
    if (!url) throw new Error("Telemetry runtime is not configured");
    return (telemetry ??= createTelemetryService(url));
  },
  {},
  () => {
    if (env("APP_TRACKING_REPORTING_ENABLED") !== "1") return undefined;
    const url = env("APP_TRACKING_REPORTING_DATABASE_URL");
    const hashes = env("APP_TRACKING_ADMIN_TOKEN_HASHES");
    if (!url || !hashes) throw new Error("Reporting runtime is not configured");
    return (reporting ??= createReportingService(url, hashes.split(",")));
  },
);
BunnySDK.net.http.serve(async (request) => {
  const response = await handle(request);
  response.headers.set("X-App-Revision", __APP_REVISION__);
  return response;
});
