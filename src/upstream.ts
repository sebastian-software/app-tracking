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

export const METRICS_URL = "https://metrics.sebastian-software.com/v1/metrics.json";
export const MIN_RELEASE_AGE_MS = 3_600_000;
const MAX_SNAPSHOT_AGE_MS = 86_400_000;

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

function parseRelease(entry: Distribution, data: unknown, now: number) {
  const document = record(data);
  const sources = record(document?.sources);
  const generated = timestamp(document?.generatedAt, now);
  const checkedAt = generated ? Date.parse(generated) : NaN;
  if (
    document?.schema !== 1 ||
    sources?.github !== "ok" ||
    sources.releases !== "ok" ||
    !Number.isFinite(checkedAt) ||
    checkedAt > now ||
    now - checkedAt >= MAX_SNAPSHOT_AGE_MS
  )
    throw new LookupFailure();
  const source = entry.source;
  const release = record(record(record(document.github)?.[source.repository])?.release);
  const version = release?.version;
  const tag = release?.tag;
  const published = timestamp(release?.publishedAt, now);
  if (
    !stableVersion(version) ||
    tag !== `${source.tagPrefix}${version}` ||
    !published ||
    Date.parse(published) > checkedAt ||
    now - Date.parse(published) < MIN_RELEASE_AGE_MS
  )
    throw new LookupFailure();
  const result: Release = {
    latest_version: version,
    published_at: published,
    release_url: `https://github.com/sebastian-software/${source.repository}/releases/tag/${encodeURIComponent(tag)}`,
  };
  // The metrics collection time survives every cache layer. Fetching an old
  // CDN snapshot must never renew its freshness or its 24-hour stale lifetime.
  return { release: result, checkedAt };
}

export async function fetchRelease(entry: Distribution, options: UpstreamOptions) {
  const url = new URL(METRICS_URL);
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
