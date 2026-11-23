import { createHash } from "node:crypto";
import type { DownloadAsset, DownloadTool } from "../../src/downloads/service.ts";
import { validateAssets } from "../../src/downloads/service.ts";

const ferrikiCatalog = "https://raw.githubusercontent.com/sebastian-software/ferriki/";
const ferriguraAssets = "https://assets.sebastian-software.com";
const sha256 = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const ferriguraManifest = /^\/ferrigura\/catalogs\/[a-z0-9-]+\/[0-9.]+\/([a-f0-9]{64})\.json$/;

export function assetDigest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fetchBytes(url: string, limit: number, credential?: string) {
  const response = await fetch(url, {
    headers: credential ? { AccessKey: credential } : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Asset fetch failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("Missing asset body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("Asset exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function shortHash(hash: string) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = BigInt(`0x${hash.slice(0, 16)}`) % 62n ** 8n;
  let short = "";
  for (let i = 0; i < 8; i++) {
    short = alphabet[Number(value % 62n)] + short;
    value /= 62n;
  }
  return short;
}

type FerrikiAsset = { size?: unknown; sha256?: unknown };

export function ferrikiAssetsFromCatalog(catalog: {
  release?: { assets?: Record<string, FerrikiAsset>; storageLayout?: unknown };
}) {
  const { assets, storageLayout } = catalog.release ?? {};
  if (!assets || !["language-hash-v1", "language-hash-v2"].includes(String(storageLayout)))
    throw new Error("Unknown Ferriki catalog layout");
  const entries: unknown[] = [];
  for (const [key, asset] of Object.entries(assets)) {
    const match = /^(languages|themes)\/([a-z0-9-]+)\.(fkgram|fkbc|fktheme)$/.exec(key);
    if (!match) continue;
    const [, kind, id, extension] = match;
    if (
      (kind === "themes") !== (extension === "fktheme") ||
      typeof asset?.sha256 !== "string" ||
      !sha256.test(asset.sha256)
    )
      throw new Error("Invalid Ferriki catalog object");
    const hash = storageLayout === "language-hash-v1" ? asset.sha256 : shortHash(asset.sha256);
    entries.push({
      path: kind === "themes" ? `/themes/${id}/${hash}` : `/${id}/${hash}`,
      sha256: asset.sha256,
      bytes: asset.size,
    });
  }
  return validateAssets("ferriki", entries);
}

type FerriguraManifest = {
  schemaVersion?: unknown;
  families?: { faces?: { renderer?: { path?: unknown; size?: unknown; sha256?: unknown } }[] }[];
};

export function ferriguraAssetsFromManifest(path: string, bytes: Uint8Array) {
  const digest = ferriguraManifest.exec(path)?.[1];
  if (!digest || assetDigest(bytes) !== digest)
    throw new Error("Ferrigura catalog pin does not match");
  const manifest: FerriguraManifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.families))
    throw new Error("Invalid Ferrigura catalog");
  const entries: unknown[] = [{ path, sha256: digest, bytes: bytes.length }];
  for (const family of manifest.families) {
    if (!Array.isArray(family.faces)) throw new Error("Invalid Ferrigura catalog family");
    for (const { renderer } of family.faces) {
      if (typeof renderer?.path !== "string") throw new Error("Missing Ferrigura renderer path");
      entries.push({
        path: `/ferrigura/${renderer.path}`,
        bytes: renderer.size,
        sha256: renderer.sha256,
      });
    }
  }
  return validateAssets("ferrigura", entries);
}

export const publicOrigin = (tool: DownloadTool) =>
  tool === "ferriki" ? "https://assets.ferriki.dev" : ferriguraAssets;

export async function readPublishedCatalog(
  tool: DownloadTool,
  pins: readonly string[],
  readFontManifest: (path: string) => Promise<Uint8Array>,
) {
  const result = new Map<string, DownloadAsset>();
  if (pins.length < 1 || pins.length > 12) throw new Error("Expected one to twelve catalog pins");
  for (const pin of pins) {
    let entries;
    if (tool === "ferriki") {
      if (!revision.test(pin)) throw new Error("Ferriki requires a full source commit");
      const bytes = await fetchBytes(`${ferrikiCatalog}${pin}/assets/catalog.json`, 2_000_000);
      entries = ferrikiAssetsFromCatalog(JSON.parse(bytes.toString("utf8")));
    } else {
      if (!ferriguraManifest.test(pin))
        throw new Error("Ferrigura requires a pinned CDN catalog path");
      const bytes = await readFontManifest(pin);
      entries = ferriguraAssetsFromManifest(pin, bytes);
    }
    for (const entry of entries) {
      const previous = result.get(entry.path);
      if (previous && (previous.sha256 !== entry.sha256 || previous.bytes !== entry.bytes))
        throw new Error("Catalogs disagree on an immutable object");
      result.set(entry.path, entry);
    }
  }
  return [...result.values()];
}
