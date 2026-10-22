import type { Distribution } from "./catalog.ts";
import { record, stableVersion, timestamp, type Release } from "./contract.ts";

export const UPSTREAM_TIMEOUT_MS = 1_500;
export const UPSTREAM_RETRY_DELAY_MS = 50;
export const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "app-tracking (https://github.com/sebastian-software/app-tracking)";

export interface UpstreamOptions {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

class LookupFailure extends Error {
  readonly retryable: boolean;
  constructor(retryable = false) {
    super("Release lookup failed");
    this.retryable = retryable;
  }
}

function destination(entry: Distribution): URL {
  const source = entry.source;
  const url =
    source.kind === "npm"
      ? new URL(`https://registry.npmjs.org/${encodeURIComponent(source.packageName)}`)
      : new URL(`https://api.github.com/repos/${source.repository}/releases/latest`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["registry.npmjs.org", "api.github.com"].includes(url.hostname)
  )
    throw new LookupFailure();
  return url;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new LookupFailure();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_UPSTREAM_BYTES) throw new LookupFailure();
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (type !== "application/json") throw new LookupFailure();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) throw new LookupFailure();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new LookupFailure();
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function parseRelease(entry: Distribution, data: unknown, now: number): Release {
  const document = record(data);
  if (!document) throw new LookupFailure();
  const source = entry.source;
  if (source.kind === "npm") {
    const version = record(document["dist-tags"])?.[source.tag];
    if (document.name !== source.packageName || !stableVersion(version)) throw new LookupFailure();
    const manifest = record(record(document.versions)?.[version]);
    const published = timestamp(record(document.time)?.[version], now);
    if (
      manifest?.name !== source.packageName ||
      manifest.version !== version ||
      manifest.deprecated ||
      !published
    )
      throw new LookupFailure();
    return {
      latest_version: version,
      published_at: published,
      release_url: `https://www.npmjs.com/package/${source.packageName}/v/${encodeURIComponent(version)}`,
    };
  }

  const tag = document.tag_name;
  if (
    document.draft !== false ||
    document.prerelease !== false ||
    typeof tag !== "string" ||
    !tag.startsWith(source.tagPrefix)
  )
    throw new LookupFailure();
  const version = tag.slice(source.tagPrefix.length);
  const published = timestamp(document.published_at, now);
  if (!stableVersion(version) || !published || !Array.isArray(document.assets))
    throw new LookupFailure();
  const assets = document.assets.map(record);
  if (
    !source.binaryTargets.every((target) =>
      assets.some(
        (asset) =>
          asset?.name === `${entry.tool}-${version}-${target}.tar.gz` &&
          asset.state === "uploaded" &&
          typeof asset.size === "number" &&
          asset.size > 0,
      ),
    )
  )
    throw new LookupFailure();
  return {
    latest_version: version,
    published_at: published,
    release_url: `https://github.com/${source.repository}/releases/tag/${encodeURIComponent(tag)}`,
  };
}

export async function fetchRelease(
  entry: Distribution,
  options: UpstreamOptions,
): Promise<Release> {
  const url = destination(entry);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
    try {
      const response = await options.fetch(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(entry.source.kind === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new LookupFailure(response.status >= 500 && response.status <= 599);
      }
      const data = await readJson(response, controller.signal);
      return parseRelease(entry, data, options.now());
    } catch (error) {
      const retryable = !(error instanceof LookupFailure) || error.retryable;
      if (!retryable || attempt === 1) throw new LookupFailure();
    } finally {
      clearTimeout(timer);
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, options.retryDelayMs ?? UPSTREAM_RETRY_DELAY_MS),
    );
  }
  throw new LookupFailure();
}
