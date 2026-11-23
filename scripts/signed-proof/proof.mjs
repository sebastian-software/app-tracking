import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { ASSET } from "./fixture.mjs";
import { bunnyApi, required } from "../bunny.ts";
import { provision } from "../provision.ts";
import { publish } from "../release.ts";

const run = required("GITHUB_RUN_ID");
const attempt = required("GITHUB_RUN_ATTEMPT");
assert(/^\d+$/.test(run) && /^\d+$/.test(attempt), "Dedicated CI run required");
const cdnName = `at-asset-proof-${run}-${attempt}`;
const issuerName = `at-issuer-proof-${run}-${attempt}`;
const cdnHost = `${cdnName}.b-cdn.net`;
const accountKey = required("BUNNY_API_KEY");
const management = bunnyApi(accountKey);
async function api(method, path, body) {
  for (let tryNumber = 0; ; tryNumber++) {
    try {
      return await management(method, path, body);
    } catch (error) {
      if (tryNumber >= 4 || !String(error.message).startsWith("Bunny operation failed (429)"))
        throw error;
      await delay(2_000 * (tryNumber + 1));
    }
  }
}
const fetchDirect = (url, options = {}) =>
  fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });

async function find(kind, name) {
  const list = await api("GET", `/${kind}?search=${name}&perPage=100`);
  const items = Array.isArray(list) ? list : list.Items;
  if (!Array.isArray(items) || items.length >= 100) throw new Error("Inexact cleanup listing");
  const matches = items.filter((item) => item.Name === name);
  if (matches.length > 1) throw new Error("Ambiguous temporary resource");
  if (matches.length === 0) return null;
  const [result] = matches;
  assert(Number.isSafeInteger(result.Id) && result.Id > 0, "Invalid temporary resource");
  return result;
}

async function remove(kind, name) {
  const item = await find(kind, name);
  if (!item) return;
  const suffix = kind === "compute/script" ? "?deleteLinkedPullZones=true" : "";
  await api("DELETE", `/${kind}/${item.Id}${suffix}`);
  for (let poll = 0; poll < 6; poll++) {
    if (!(await find(kind, name))) return;
    await delay(1_000);
  }
  throw new Error("Temporary resource still listed");
}

async function cleanup() {
  const targets = [
    ["compute/script", issuerName],
    ["pullzone", issuerName],
    ["pullzone", cdnName],
    ["storagezone", cdnName],
  ];
  let failed = false;
  for (const [kind, name] of targets) {
    try {
      await remove(kind, name);
    } catch (error) {
      failed = true;
      console.error(`Cleanup needs attention for ${kind} ${name}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log("Verified temporary issuer, Pull Zones and Storage Zone are absent.");
}

async function verifyBytes(response, label) {
  assert.equal(response.status, 200, label);
  const hash = createHash("sha256");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert(bytes <= ASSET.bytes, `${label}: size limit`);
    hash.update(chunk);
    chunks.push(chunk);
  }
  assert.equal(bytes, ASSET.bytes, `${label}: byte length`);
  assert.equal(hash.digest("hex"), ASSET.sha256, `${label}: SHA-256`);
  return Buffer.concat(chunks);
}

async function expectStatus(url, status, label, options) {
  const response = await fetchDirect(url, options);
  await response.body?.cancel();
  assert.equal(response.status, status, label);
}

async function runProof() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const resolvedSdk = fileURLToPath(
    new URL("../esm-bunny/lib.mjs", import.meta.resolve("@bunny.net/edgescript-sdk")),
  );
  const { outputFiles } = await build({
    entryPoints: ["scripts/signed-proof/issuer.mjs"],
    write: false,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    alias: { "@bunny.net/edgescript-sdk": resolvedSdk },
    logLevel: "silent",
  });
  const bytes = await verifyBytes(await fetchDirect(ASSET.source), "Published Ferriki fixture");

  stage = "create isolated Storage Zone";
  assert.equal(await find("storagezone", cdnName), null, "Storage fixture exists");
  const storage = await api("POST", "/storagezone", { Name: cdnName, Region: "DE" });
  assert(storage.Name === cdnName && Number.isSafeInteger(storage.Id) && storage.Id > 0);

  stage = "create token-protected Pull Zone";
  assert.equal(await find("pullzone", cdnName), null, "CDN fixture exists");
  const pull = await api("POST", "/pullzone", {
    Name: cdnName, Type: "Premium", OriginType: "StorageZone", StorageZoneId: storage.Id,
    PreloadingScreenShowOnFirstVisit: false, ZoneSecurityEnabled: true,
    EnableLogging: false, LoggingSaveToStorage: false, LogForwardingEnabled: false,
  });
  assert(pull.Name === cdnName && Number.isSafeInteger(pull.Id) && pull.Id > 0);
  await api("POST", `/pullzone/${pull.Id}`, {
    ZoneSecurityEnabled: true, ZoneSecurityIncludeHashRemoteIP: false,
    EnableLogging: false, LoggingSaveToStorage: false, LogForwardingEnabled: false,
  });
  const verified = await api("GET", `/pullzone/${pull.Id}`);
  assert(verified.Name === cdnName && verified.StorageZoneId === storage.Id &&
    verified.ZoneSecurityEnabled === true && verified.EnableLogging === false);
  const cdnKey = verified.ZoneSecurityKey;
  assert(typeof cdnKey === "string" && cdnKey.length >= 16, "Missing Pull Zone signing key");

  stage = "upload verified fixture to private Storage Zone";
  const storageDetails = await api("GET", `/storagezone/${storage.Id}`);
  assert(storageDetails.Name === cdnName &&
    typeof storageDetails.Password === "string" && storageDetails.Password.length > 0);
  assert(String(storageDetails.Region).toUpperCase() === "DE", "Storage region must be Frankfurt");
  const origin = new URL(`https://storage.bunnycdn.com/${cdnName}${ASSET.path}`);
  let uploadStatus;
  for (let i = 0; i < 10; i++) {
    const uploaded = await fetchDirect(origin, {
      method: "PUT",
      headers: {
        AccessKey: storageDetails.Password,
        "Content-Type": "application/octet-stream",
        Checksum: ASSET.sha256.toUpperCase(),
      },
      body: bytes,
    });
    uploadStatus = uploaded.status;
    await uploaded.body?.cancel();
    if (uploaded.ok || ![401, 404, 503].includes(uploadStatus)) break;
    // A newly provisioned Storage Zone may not have reached the region yet.
    await delay(5_000);
  }
  assert.equal(uploadStatus, 201, "Storage PUT");

  stage = "publish isolated Bunny issuer";
  const { target } = await provision(api, issuerName, issuerName);
  const buildToken = randomBytes(32).toString("hex");
  for (const [Name, Secret] of [
    ["PROOF_BUILD_TOKEN", buildToken], ["PROOF_CDN_KEY", cdnKey], ["PROOF_CDN_HOST", cdnHost],
  ]) await api("PUT", `/compute/script/${target.scriptId}/secrets`, { Name, Secret });
  await publish(api, target, outputFiles[0].text, revision);
  const endpoint = new URL(`/v1/downloads/${ASSET.id}`, target.base);
  const issue = (token, url = endpoint) => fetchDirect(url, {
    method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  stage = "verify issuer authorization and deny static URLs";
  let ready = false;
  for (let i = 0; i < 16; i++) {
    try {
      const response = await issue();
      await response.body?.cancel();
      if (response.status === 401) { ready = true; break; }
    } catch {
      // Distribution of a new edge script and hostname can take a short time.
    }
    await delay(4_000);
  }
  assert(ready, "Anonymous issuer did not reach expected HTTP 401");
  const wrong = await issue("0".repeat(64));
  await wrong.body?.cancel();
  assert.equal(wrong.status, 401, "wrong build token");
  const missing = await issue(buildToken, new URL("/v1/downloads/unknown", target.base));
  await missing.body?.cancel();
  assert.equal(missing.status, 404, "unlisted asset");
  const unsigned = new URL(ASSET.path, `https://${cdnHost}`);
  await expectStatus(unsigned, 403, "unsigned CDN request");
  await expectStatus(origin, 401, "unauthenticated Storage origin");

  stage = "verify one authorized download and signed-path scope";
  const ticket = await issue(buildToken);
  assert.equal(ticket.status, 200, "build authorized");
  assert(/\bno-store\b/i.test(ticket.headers.get("cache-control") ?? ""), "ticket is not cacheable");
  const receipt = await ticket.json();
  assert.equal(receipt.bytes, ASSET.bytes, "issued byte length");
  assert.equal(receipt.sha256, ASSET.sha256, "issued SHA-256");
  const signed = new URL(receipt.url);
  assert(signed.protocol === "https:" && signed.host === cdnHost &&
    signed.pathname === ASSET.path && !signed.username && !signed.password &&
    /^HS256-[a-zA-Z0-9_-]{43}$/.test(signed.searchParams.get("token") ?? ""), "Invalid issued URL");
  const expires = Number(signed.searchParams.get("expires"));
  assert(Number.isSafeInteger(expires) && expires > Date.now() / 1000 &&
    expires <= Date.now() / 1000 + 22, "Invalid expiration");
  await verifyBytes(await fetchDirect(signed), "Authorized CDN download");
  const replay = await fetchDirect(signed);
  const replayCache = replay.headers.get("cdn-cache");
  await verifyBytes(replay, "Same link while valid");
  await expectStatus(unsigned, 403, "unsigned CDN request after successful transfer");
  const changed = new URL(signed);
  changed.pathname += "-other";
  await expectStatus(changed, 403, "signature presented on a different asset path");
  console.log(JSON.stringify({
    unauthorized_issuance: 401, wrong_build_token: 401, unknown_asset: 404,
    unsigned_cdn: 403, unsigned_origin: 401, signed_verified: 200,
    repeated_link_until_expiry: 200, replay_cache: ["HIT", "MISS"].includes(replayCache) ? replayCache : "other",
    different_path: 403, bytes: ASSET.bytes,
  }));

  stage = "verify cached asset is denied after URL expiry";
  await delay(Math.max(0, expires * 1000 - Date.now()) + 2_000);
  await expectStatus(signed, 403, "previously successful signed URL after expiry");
  console.log(JSON.stringify({ expired_link_after_success: 403 }));
}

let stage = "prepare bounded fixture";
if (process.argv[2] === "--cleanup") {
  await cleanup();
} else {
  try {
    await runProof();
  } catch (error) {
    // All assertions use public fixture metadata/status or a fixed message. A fetch error
    // cause can contain its input URL, so never print a stack, cause or provider response.
    console.error(`Proof failed at ${stage}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
