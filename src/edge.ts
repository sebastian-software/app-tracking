import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { createHandler } from "./handler.ts";

BunnySDK.net.http.serve(createHandler());
