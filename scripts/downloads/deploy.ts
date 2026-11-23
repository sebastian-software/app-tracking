import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolveCname } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bunnyApi, required } from "../bunny.ts";
import type { BunnyApi } from "../bunny.ts";
import { provision } from "../provision.ts";
import { publish } from "../release.ts";
import { downloadHosts } from "../../src/downloads/service.ts";
import type { DownloadAsset, DownloadTool } from "../../src/downloads/service.ts";
import { assetDigest, fetchBytes, publicOrigin, readPublishedCatalog } from "./catalog.ts";

type Zone = {
  Id: number;
  Name: string;
  Region?: string;
  Password?: string;
  StorageZoneId?: number;
  EnableLogging?: boolean;
  LoggingSaveToStorage?: boolean;
  LogForwardingEnabled?: boolean;
  ZoneSecurityEnabled?: boolean;
  ZoneSecurityIncludeHashRemoteIP?: boolean;
  ZoneSecurityKey?: string;
  Hostnames?: { Value: string; HasCertificate: boolean }[];
};
const request = (url: string | URL, options?: RequestInit) =>
  fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(60_000) });
const disabledLogs = {
  EnableLogging: false,
  LoggingSaveToStorage: false,
  LogForwardingEnabled: false,
};
const toolName = required("DOWNLOAD_TOOL");
assert(toolName === "ferriki" || toolName === "ferrigura", "Unknown tool");
const tool: DownloadTool = toolName;
const zoneName = `at-${tool}-protected-assets`;
const issuerName = `at-${tool}-downloads`;
const { issuer, cdn } = downloadHosts[tool];
const provider = bunnyApi(required("BUNNY_API_KEY"));
const api: BunnyApi = async (method, path, body) => {
  for (let i = 0; ; i++) {
    try {
      return await provider(method, path, body);
    } catch (error) {
      if (
        i >= 4 ||
        !(error instanceof Error) ||
        !error.message.startsWith("Bunny operation failed (429)")
      )
        throw error;
      await delay((i + 1) * 2_000);
    }
  }
};

async function find(kind: "storagezone" | "pullzone", name: string) {
  const result = await api<Zone[] | { Items: Zone[] }>(
    "GET",
    `/${kind}?search=${name}&perPage=100`,
  );
  const items = Array.isArray(result) ? result : result.Items;
  assert(Array.isArray(items) && items.length < 100, "Inexact zone listing");
  const matches = items.filter((item) => item.Name === name);
  assert(matches.length <= 1, "Ambiguous zone");
  return matches[0];
}

async function privateZone() {
  const existing = await find("storagezone", zoneName);
  const storage =
    existing ?? (await api<Zone>("POST", "/storagezone", { Name: zoneName, Region: "DE" }));
  assert(storage.Name === zoneName && Number.isSafeInteger(storage.Id) && storage.Id > 0);
  const details = await api<Zone>("GET", `/storagezone/${storage.Id}`);
  assert(
    details.Name === zoneName && details.Region?.toUpperCase() === "DE" && details.Password,
    "Private storage does not match",
  );

  const pull =
    (await find("pullzone", zoneName)) ??
    (await api<Zone>("POST", "/pullzone", {
      Name: zoneName,
      Type: "Premium",
      OriginType: "StorageZone",
      StorageZoneId: storage.Id,
      PreloadingScreenShowOnFirstVisit: false,
      ZoneSecurityEnabled: true,
      ...disabledLogs,
    }));
  assert(
    pull.Name === zoneName && pull.StorageZoneId === storage.Id,
    "Private CDN origin does not match",
  );
  await api("POST", `/pullzone/${pull.Id}`, {
    ZoneSecurityEnabled: true,
    ZoneSecurityIncludeHashRemoteIP: false,
    CacheErrorResponses: false,
    ...disabledLogs,
  });
  const verified = await api<Zone>("GET", `/pullzone/${pull.Id}`);
  assert(
    verified.Name === zoneName &&
      verified.StorageZoneId === storage.Id &&
      verified.ZoneSecurityEnabled === true &&
      verified.ZoneSecurityIncludeHashRemoteIP === false &&
      verified.EnableLogging === false &&
      !verified.LoggingSaveToStorage &&
      !verified.LogForwardingEnabled &&
      typeof verified.ZoneSecurityKey === "string" &&
      verified.ZoneSecurityKey.length >= 16,
    "Protected zone configuration did not converge",
  );
  return { pull: verified, password: details.Password, signingKey: verified.ZoneSecurityKey };
}

function verify(asset: DownloadAsset, bytes: Uint8Array) {
  assert(
    bytes.byteLength === asset.bytes && assetDigest(bytes) === asset.sha256,
    "Actual asset identity mismatch",
  );
}

const storageOrigin = `https://storage.bunnycdn.com/${zoneName}`;
const canImportPublic = process.env.DOWNLOAD_IMPORT_PUBLIC === "true";

async function waitForStorage(password: string) {
  // Wait for the Storage region to recognize newly provisioned credentials.
  let ready = false;
  for (let i = 0; i < 12; i++) {
    const response = await request(`${storageOrigin}/`, { headers: { AccessKey: password } });
    await response.body?.cancel();
    if (response.ok) {
      ready = true;
      break;
    }
    if (![401, 404, 503].includes(response.status)) break;
    await delay(5_000);
  }
  assert(ready, "Storage region did not become ready");
}

async function copyAssets(assets: DownloadAsset[], password: string) {
  async function sync(asset: DownloadAsset) {
    const target = storageOrigin + asset.path;
    try {
      verify(asset, await fetchBytes(target, asset.bytes, password));
      return;
    } catch (error) {
      if (
        !canImportPublic ||
        !(error instanceof Error) ||
        error.message !== "Asset fetch failed (HTTP 404)"
      )
        throw error;
    }
    const bytes = await fetchBytes(publicOrigin(tool) + asset.path, asset.bytes);
    verify(asset, bytes);
    const response = await request(target, {
      method: "PUT",
      headers: {
        AccessKey: password,
        "Content-Type": asset.path.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
        Checksum: asset.sha256.toUpperCase(),
      },
      body: new Uint8Array(bytes),
    });
    await response.body?.cancel();
    assert.equal(response.status, 201, "Storage upload");
    verify(asset, await fetchBytes(target, asset.bytes, password));
  }
  for (let i = 0; i < assets.length; i += 8) await Promise.all(assets.slice(i, i + 8).map(sync));
}

async function enableHost(zoneId: number, host: string, expectedCname: string) {
  const records = await resolveCname(host);
  assert(
    records.length === 1 && records[0].replace(/\.$/, "").toLowerCase() === expectedCname,
    `Missing exact CNAME for ${host}`,
  );
  const zone = await api<Zone>("GET", `/pullzone/${zoneId}`);
  if (!zone.Hostnames?.some((entry) => entry.Value === host))
    await api("POST", `/pullzone/${zoneId}/addHostname`, { Hostname: host });
  for (let i = 0; i < 10; i++) {
    const current = await api<Zone>("GET", `/pullzone/${zoneId}`);
    if (current.Hostnames?.some((entry) => entry.Value === host && entry.HasCertificate)) {
      await api("POST", `/pullzone/${zoneId}/setForceSSL`, { Hostname: host, ForceSSL: true });
      return;
    }
    await api("GET", `/pullzone/loadFreeCertificate?hostname=${host}`);
    await delay(5_000);
  }
  throw new Error(`TLS certificate is pending for ${host}`);
}

async function deploy() {
  const mode = process.argv[2];
  assert(mode === "prepare" || mode === "activate", "Expected prepare or activate");
  const token = required("DOWNLOAD_BUILD_TOKEN");
  assert(/^[a-f0-9]{64}$/.test(token), "Invalid build credential");
  const otherTokens: unknown = JSON.parse(process.env.DOWNLOAD_ADDITIONAL_TOKEN_SHA256 ?? "[]");
  assert(
    Array.isArray(otherTokens) &&
      otherTokens.every(
        (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      ),
    "Invalid additional token digests",
  );

  const input = JSON.parse(required("DOWNLOAD_CATALOG_PINS"));
  assert(Array.isArray(input) && input.every((pin: unknown) => typeof pin === "string"));
  const storage = await privateZone();
  await waitForStorage(storage.password);
  const assets = await readPublishedCatalog(tool, input, async (path) => {
    try {
      return await fetchBytes(storageOrigin + path, 2_000_000, storage.password);
    } catch (error) {
      if (
        !canImportPublic ||
        !(error instanceof Error) ||
        error.message !== "Asset fetch failed (HTTP 404)"
      )
        throw error;
      return fetchBytes(publicOrigin(tool) + path, 2_000_000);
    }
  });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sdk = fileURLToPath(
    new URL("../esm-bunny/lib.mjs", import.meta.resolve("@bunny.net/edgescript-sdk")),
  );
  const notice = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  const bundle = await build({
    entryPoints: ["src/downloads/edge.ts"],
    write: false,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    alias: { "@bunny.net/edgescript-sdk": sdk },
    define: {
      __APP_REVISION__: JSON.stringify(revision),
      __DOWNLOAD_TOOL__: JSON.stringify(tool),
      __DOWNLOAD_ASSETS__: JSON.stringify(assets),
    },
    banner: { js: `/*\n${notice}\n*/` },
    metafile: true,
    logLevel: "silent",
  });
  assert(Object.values(bundle.metafile.outputs).every((entry) => !entry.imports.length));
  await copyAssets(assets, storage.password);
  console.log(`${tool}: staged and verified ${assets.length} private CDN objects.`);
  const { target } = await provision(api, issuerName, issuerName);
  for (const [Name, Secret] of [
    [
      "APP_TRACKING_DOWNLOAD_TOKEN_SHA256",
      JSON.stringify([assetDigest(Buffer.from(token)), ...otherTokens]),
    ],
    ["APP_TRACKING_DOWNLOAD_CDN_KEY", storage.signingKey],
  ])
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, { Name, Secret });
  await publish(api, target, bundle.outputFiles[0].text, revision);
  console.log(`DNS: ${issuer} -> ${issuerName}.b-cdn.net`);
  console.log(`DNS: ${cdn} -> ${zoneName}.b-cdn.net`);
  if (mode === "prepare") return;

  await enableHost(storage.pull.Id, cdn, `${zoneName}.b-cdn.net`);
  await enableHost(target.zoneId, issuer, `${issuerName}.b-cdn.net`);
  const [asset] = assets;
  const endpoint = `https://${issuer}/v1/downloads`;
  const post = (token?: string) =>
    request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ path: asset.path, sha256: asset.sha256 }),
    });
  let response;
  for (let i = 0; i < 12; i++) {
    try {
      response = await post();
      if (response.status === 401 && response.headers.get("x-app-revision") === revision) break;
      await response.body?.cancel();
    } catch {
      // Newly added hostnames can take time to be routed.
    }
    await delay(4_000);
  }
  assert(
    response?.status === 401 && response.headers.get("x-app-revision") === revision,
    "Issuer not ready",
  );
  await response.body?.cancel();

  const unsigned = await request(`https://${cdn}${asset.path}`);
  await unsigned.body?.cancel();
  assert.equal(unsigned.status, 403, "Unsigned custom-domain fetch");
  const granted = await post(token);
  assert.equal(granted.status, 200, "Protected link issuance");
  const value = await granted.json();
  const signed = new URL(value.url);
  assert(
    signed.origin === `https://${cdn}` &&
      signed.pathname === asset.path &&
      value.sha256 === asset.sha256 &&
      value.bytes === asset.bytes,
    "Invalid protected grant",
  );
  verify(asset, await fetchBytes(signed.href, asset.bytes));
  console.log(
    `${tool}: verified authorized access and denied unsigned access on both custom domains.`,
  );
}
try {
  await deploy();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Protected download deployment failed");
  process.exitCode = 1;
}
