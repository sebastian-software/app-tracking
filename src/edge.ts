import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createHandler } from "./handler.ts";
declare const __APP_REVISION__: string;
const handle = createHandler();
BunnySDK.net.http.serve(async (request) => {
  const response = await handle(request);
  response.headers.set("X-App-Revision", __APP_REVISION__);
  return response;
});
