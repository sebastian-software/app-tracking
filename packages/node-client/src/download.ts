/// <reference lib="esnext.disposable" preserve="true" />
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { endpoint, readBody, request } from "./transport.ts";
import {
  fail,
  TrackingError,
  type DownloadOptions,
  type Resource,
  type SignedResource,
} from "./types.ts";

export class VerifiedDownload implements AsyncDisposable {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  #directory: string;
  #closing?: Promise<void>;
  constructor(resource: Resource, directory: string, path: string) {
    this.id = resource.id;
    this.bytes = resource.bytes;
    this.sha256 = resource.sha256;
    this.path = path;
    this.#directory = directory;
  }
  /** Copy the artifact into the host's cache before removing this temporary directory. */
  close(): Promise<void> {
    return (this.#closing ??= rm(this.#directory, { recursive: true, force: true }));
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

const digestPattern = /^[a-f0-9]{64}$/;

function downloadLimits(
  resource: Pick<SignedResource, "id" | "bytes" | "sha256">,
  options: DownloadOptions,
  offline: boolean,
) {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(resource.id) ||
    !digestPattern.test(resource.sha256) ||
    ![maxBytes, timeoutMs].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    timeoutMs === 0 ||
    timeoutMs > 600_000 ||
    (resource.bytes !== undefined &&
      (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > maxBytes))
  )
    fail("Configuration");
  if (offline) fail("Offline");
  if (options.signal?.aborted) fail("Cancelled");
  return { maxBytes, timeoutMs };
}

export function download(resource: Resource, options: DownloadOptions, offline: boolean) {
  const url = endpoint(resource.url, false);
  if (resource.bytes === undefined) fail("Configuration");
  const { maxBytes, timeoutMs } = downloadLimits(resource, options, offline);
  return transfer(resource, url, maxBytes, timeoutMs, options.signal);
}

export async function downloadSigned(
  resource: SignedResource,
  buildToken: string,
  options: DownloadOptions = {},
) {
  const issuer = endpoint(resource.issuerUrl, false);
  const cdn = endpoint(resource.cdnOrigin, true);
  const path = resource.path;
  if (
    issuer.pathname !== "/v1/downloads" ||
    typeof buildToken !== "string" ||
    !digestPattern.test(buildToken) ||
    typeof path !== "string" ||
    path.length > 240 ||
    !path.startsWith("/") ||
    !path
      .slice(1)
      .split("/")
      .every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")
  )
    fail("Configuration");
  const { maxBytes, timeoutMs } = downloadLimits(resource, options, false);
  const started = performance.now();
  const body = JSON.stringify({ path, sha256: resource.sha256 });
  const connection = await request(
    issuer,
    "POST",
    {
      Authorization: `Bearer ${buildToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "Accept-Encoding": "identity",
    },
    body,
    timeoutMs,
    options.signal,
  );

  let grant: Partial<Resource>;
  try {
    const { response } = connection;
    if (response.statusCode !== 200) fail("HttpStatus");
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
      fail("Integrity");
    let candidate: unknown;
    try {
      candidate = JSON.parse(await readBody(response, 8_192));
    } catch (error) {
      if (error instanceof TrackingError) throw error;
      fail("Integrity");
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("Integrity");
    grant = candidate as Partial<Resource>;
  } catch (error) {
    if (options.signal?.aborted) fail("Cancelled");
    throw error;
  } finally {
    connection.close();
  }
  const { url: signed, bytes, sha256 } = grant;
  const prefix = resource.cdnOrigin.replace(/\/$/, "") + path + "?";
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > maxBytes ||
    (resource.bytes !== undefined && resource.bytes !== bytes) ||
    sha256 !== resource.sha256 ||
    typeof signed !== "string" ||
    !signed.startsWith(prefix)
  )
    fail("Integrity");
  const parameters = signed.slice(prefix.length).split("&");
  if (
    parameters.length !== 2 ||
    !parameters.some((parameter) => /^token=HS256-[A-Za-z0-9_-]{43}$/.test(parameter)) ||
    !parameters.some((parameter) => /^expires=[1-9][0-9]{0,12}$/.test(parameter))
  )
    fail("Integrity");
  const timeout = Math.floor(timeoutMs - (performance.now() - started));
  if (options.signal?.aborted) fail("Cancelled");
  if (timeout <= 0) fail("Network");
  return transfer(
    { id: resource.id, url: signed, bytes, sha256 },
    new URL(path + "?" + parameters.join("&"), cdn),
    maxBytes,
    timeout,
    options.signal,
  );
}

async function transfer(
  resource: Resource,
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const connection = await request(
    url,
    "GET",
    { "Accept-Encoding": "identity", "User-Agent": "app-tracking-node" },
    undefined,
    timeoutMs,
    signal,
  );
  let directory: string | undefined;
  let file;
  try {
    const { response } = connection;
    if (response.statusCode !== 200) fail("HttpStatus");
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
      fail("Integrity");
    if (
      response.headers["content-length"] !== undefined &&
      response.headers["content-length"] !== String(resource.bytes)
    )
      fail("Integrity");
    try {
      directory = await mkdtemp(join(tmpdir(), "app-tracking-resource-"));
      file = await open(join(directory, "artifact"), "wx", 0o600);
    } catch {
      fail("DownloadStorage");
    }
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response) {
      if (signal?.aborted) fail("Cancelled");
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > resource.bytes || bytes > maxBytes) fail("Integrity");
      digest.update(buffer);
      try {
        await file.writeFile(buffer);
      } catch {
        fail("DownloadStorage");
      }
    }
    if (signal?.aborted) fail("Cancelled");
    if (bytes !== resource.bytes || digest.digest("hex") !== resource.sha256) fail("Integrity");
    try {
      await file.sync();
      await file.close();
      file = undefined;
    } catch {
      fail("DownloadStorage");
    }
    const result = new VerifiedDownload(resource, directory, join(directory, "artifact"));
    directory = undefined;
    return result;
  } catch (error) {
    if (signal?.aborted) fail("Cancelled");
    if (error instanceof TrackingError) throw error;
    return fail("Network");
  } finally {
    connection.close();
    await file?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
