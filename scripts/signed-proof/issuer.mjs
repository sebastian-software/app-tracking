import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { ASSET } from "./fixture.mjs";

const env = (name) => globalThis.Deno?.env.get(name) ?? globalThis.process?.env?.[name];
const token = env("PROOF_BUILD_TOKEN");
const secret = env("PROOF_CDN_KEY");
const host = env("PROOF_CDN_HOST");
if (!token || !secret || !/^at-asset-proof-[0-9]+-[0-9]+\.b-cdn\.net$/.test(host))
  throw new Error("Incomplete isolated fixture");
const encoder = new TextEncoder();
const key = await crypto.subtle.importKey(
  "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
);
const buildKey = await crypto.subtle.importKey(
  "raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["verify", "sign"],
);
const challenge = encoder.encode("signed-asset-proof");
const buildProof = await crypto.subtle.sign("HMAC", buildKey, challenge);
const headers = { "Cache-Control": "private, no-store" };

BunnySDK.net.http.serve(async (request) => {
  const target = new URL(request.url);
  if (request.method !== "POST" || target.pathname !== `/v1/downloads/${ASSET.id}` || target.search)
    return new Response(null, { status: 404, headers });
  const candidate = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!candidate) return new Response(null, { status: 401, headers });
  const candidateKey = await crypto.subtle.importKey(
    "raw", encoder.encode(candidate), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  if (!(await crypto.subtle.verify("HMAC", candidateKey, buildProof, challenge)))
    return new Response(null, { status: 401, headers });

  const expires = Math.floor(Date.now() / 1000) + 20;
  const url = new URL(ASSET.path, `https://${host}`);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(url.pathname + expires));
  const hash = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  url.searchParams.set("token", `HS256-${hash}`);
  url.searchParams.set("expires", String(expires));
  return Response.json({ url: url.href, bytes: ASSET.bytes, sha256: ASSET.sha256 }, { headers });
});
