import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createProofHandler } from "../../src/storage/proof-handler.ts";
declare const __APP_REVISION__: string;
const deno = (
  globalThis as unknown as { Deno?: { env: { get(name: string): string | undefined } } }
).Deno;
function env(name: string) {
  const value = deno?.env.get(name) ?? globalThis.process?.env?.[name];
  if (!value) throw new Error("Proof environment is incomplete");
  return value;
}
const handle = createProofHandler(env("PROOF_DATABASE_URL"), env("PROOF_AUTH_TOKEN"));
BunnySDK.net.http.serve(async (request) => {
  const response = await handle(request);
  response.headers.set("X-App-Revision", __APP_REVISION__);
  return response;
});
