import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createDownloadService } from "./service.ts";
import type { DownloadTool } from "./service.ts";

declare const __DOWNLOAD_TOOL__: DownloadTool;
declare const __DOWNLOAD_ASSETS__: unknown;
declare const __APP_REVISION__: string;

const deno = (
  globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }
).Deno;
const env = (name: string) => deno?.env.get(name) ?? globalThis.process?.env?.[name];
const handle = await createDownloadService({
  tool: __DOWNLOAD_TOOL__,
  assets: __DOWNLOAD_ASSETS__,
  tokenSha256: JSON.parse(env("APP_TRACKING_DOWNLOAD_TOKEN_SHA256") ?? "[]"),
  signingKey: env("APP_TRACKING_DOWNLOAD_CDN_KEY"),
});
BunnySDK.net.http.serve(async (request) => {
  const response = await handle(request);
  response.headers.set("X-App-Revision", __APP_REVISION__);
  return response;
});
