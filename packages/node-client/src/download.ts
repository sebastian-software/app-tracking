/// <reference lib="esnext.disposable" preserve="true" />
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { endpoint, request } from "./transport.ts";
import { fail, TrackingError, type DownloadOptions, type Resource } from "./types.ts";

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

export async function download(
  resource: Resource,
  options: DownloadOptions,
  offline: boolean,
): Promise<VerifiedDownload> {
  const url = endpoint(resource.url, false);
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(resource.id) ||
    !/^[a-f0-9]{64}$/.test(resource.sha256) ||
    ![resource.bytes, maxBytes, timeoutMs].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    timeoutMs === 0 ||
    timeoutMs > 600_000 ||
    resource.bytes > maxBytes
  )
    fail("Configuration");
  if (offline) fail("Offline");
  if (options.signal?.aborted) fail("Cancelled");
  const connection = await request(
    url,
    "GET",
    { "Accept-Encoding": "identity", "User-Agent": "app-tracking-node" },
    undefined,
    timeoutMs,
    options.signal,
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
      if (options.signal?.aborted) fail("Cancelled");
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
    if (options.signal?.aborted) fail("Cancelled");
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
    if (options.signal?.aborted) fail("Cancelled");
    if (error instanceof TrackingError) throw error;
    return fail("Network");
  } finally {
    connection.close();
    await file?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
