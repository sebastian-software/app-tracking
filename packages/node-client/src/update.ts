import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { directory, lock, random, type Lease } from "./state.ts";
import { endpoint, readBody, request } from "./transport.ts";
import { TrackingError } from "./types.ts";
import { strictJSON } from "../../../src/telemetry/json.ts";
import {
  UPDATE_NETWORK_BUDGET_MS,
  HOUR,
  UpdateError,
  cancelled,
  defer,
  empty,
  freshResponse,
  notice,
  release,
  releaseShape,
  releaseFields,
  validEtag,
  version,
  type Update,
  type UpdateClientOptions,
  type UpdateMode,
  type UpdateState,
} from "./update-contract.ts";

export { UPDATE_NETWORK_BUDGET_MS, UpdateError } from "./update-contract.ts";
export type {
  Update,
  UpdateClientOptions,
  UpdateMode,
  UpdateErrorCode,
} from "./update-contract.ts";
const MAX_CACHE = 65_536;
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

/** Independent advisory updates. Construction performs no I/O or collection. */
export class UpdateClient {
  #options: UpdateClientOptions;
  #resource: string;
  #directory: string;
  #path: string;
  constructor(options: UpdateClientOptions) {
    const slug = (s: unknown, limit: number) =>
      typeof s === "string" && s.length <= limit && /^[a-z]/.test(s) && !/[^a-z0-9-]/.test(s);
    try {
      if (
        !options ||
        typeof options.origin !== "string" ||
        !/^https?:\/\/[^/?#\\\s]+\/?$/.test(options.origin) ||
        !isAbsolute(options.cacheRoot) ||
        !slug(options.tool, 64) ||
        !slug(options.distribution, 32) ||
        !slug(options.channel ?? "stable", 32) ||
        !version(options.version) ||
        (options.serviceMetrics !== undefined && typeof options.serviceMetrics !== "boolean")
      )
        throw new UpdateError("Configuration");
      const origin = endpoint(options.origin, true).origin;
      if (origin.startsWith("http:")) {
        const authority = options.origin.slice(7).replace(/\/$/, "");
        if (
          !/^(?:127\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})|\[::1\])(?::[0-9]+)?$/.test(
            authority,
          )
        )
          throw new UpdateError("Configuration");
      }
      const dnt = process.env.DO_NOT_TRACK;
      this.#options = {
        ...options,
        origin,
        channel: options.channel ?? "stable",
        serviceMetrics:
          options.serviceMetrics !== false && !(dnt && dnt !== "0" && dnt !== "false"),
      };
      this.#resource = `${origin}/v1/versions/${options.tool}/${options.distribution}/${this.#options.channel}`;
      // Separate from Rust's OS-locked update cache and all reporting state.
      this.#directory = join(options.cacheRoot, "node-updates-v1");
      this.#path = join(
        this.#directory,
        `${options.tool}.${options.distribution}.${this.#options.channel}.json`,
      );
    } catch {
      throw new UpdateError("Configuration");
    }
  }
  /** One attempt when due; await completion or cancel and await rejection before exit. */
  async check(
    mode: UpdateMode,
    options: { signal?: AbortSignal } = {},
  ): Promise<Update | undefined> {
    if (!["enabled", "disabled", "offline"].includes(mode)) throw new UpdateError("Configuration");
    if (mode !== "enabled") return;
    const signal = options.signal;
    cancelled(signal);
    let lease: Lease | undefined;
    try {
      await directory(this.#directory, true);
      cancelled(signal);
      try {
        lease = await lock(this.#path);
      } catch (e) {
        cancelled(signal);
        if (e instanceof TrackingError && e.code === "Busy") return;
        throw e;
      }
      cancelled(signal);
      const now = Math.floor(Date.now() / 1000);
      if (!integer(now)) throw new UpdateError("Configuration");
      const state = await this.#load(now);
      cancelled(signal);
      const due = now >= state.next_check;
      if (due) {
        defer(state, now);
        await this.#save(state, lease, signal);
        cancelled(signal);
        lease.check();
        const result = await this.#fetch(state, now, signal);
        cancelled(signal);
        state.release = result.release;
        state.etag = result.etag;
        if (!result.release.stale) {
          state.failures = 0;
          state.next_check = now + HOUR + 1;
        }
      }
      const update = notice(state, this.#options, now);
      if (due || update) await this.#save(state, lease, signal);
      cancelled(signal);
      return update;
    } catch (error) {
      cancelled(signal);
      if (error instanceof UpdateError) throw error;
      throw new UpdateError("Cache");
    } finally {
      if (lease) {
        try {
          await lease();
        } catch {
          throw new UpdateError("Cache");
        }
      }
    }
  }
  async #load(now: number): Promise<UpdateState> {
    let file;
    try {
      const meta = await lstat(this.#path);
      if (
        meta.isSymbolicLink() ||
        !meta.isFile() ||
        (process.platform !== "win32" && (meta.mode & 0o077) !== 0)
      )
        throw new UpdateError("Cache");
      if (meta.size > MAX_CACHE) return empty(this.#resource);
      file = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await file.stat();
      if (actual.ino !== meta.ino || actual.dev !== meta.dev) throw new UpdateError("Cache");
      const buffer = Buffer.alloc(MAX_CACHE + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > MAX_CACHE) return empty(this.#resource);
      let s: UpdateState;
      try {
        s = strictJSON(buffer.toString("utf8", 0, bytesRead)) as UpdateState;
      } catch {
        return empty(this.#resource);
      }
      if (
        !s ||
        s.schema_version !== 1 ||
        s.resource !== this.#resource ||
        ![s.next_check, s.failures, s.noticed_at].every(integer) ||
        s.failures > 0xffff_ffff ||
        !(s.noticed_version === null || typeof s.noticed_version === "string") ||
        !(s.etag === null || typeof s.etag === "string") ||
        !(s.release === null || releaseShape(s.release))
      )
        return empty(this.#resource);
      if (s.next_check > now + HOUR + 1) s.next_check = 0;
      if (s.noticed_at > now) s.noticed_at = 0;
      if (!validEtag(s.etag)) s.etag = null;
      return {
        schema_version: 1,
        resource: s.resource,
        next_check: s.next_check,
        failures: s.failures,
        noticed_at: s.noticed_at,
        noticed_version: s.noticed_version,
        etag: s.etag,
        release: s.release ? releaseFields(s.release) : null,
      };
    } catch (e) {
      if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === "ENOENT")
        return empty(this.#resource);
      throw e;
    } finally {
      await file?.close();
    }
  }
  async #save(state: UpdateState, lease: Lease, signal?: AbortSignal): Promise<void> {
    const temporary = `${this.#path}.${random()}.tmp`;
    let file;
    try {
      cancelled(signal);
      lease.check();
      file = await open(temporary, "wx", 0o600);
      cancelled(signal);
      lease.check();
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_CACHE) throw new UpdateError("Cache");
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = undefined;
      cancelled(signal);
      lease.check();
      await rename(temporary, this.#path);
    } finally {
      await file?.close();
      await rm(temporary, { force: true });
    }
  }
  async #fetch(state: UpdateState, now: number, signal?: AbortSignal) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "User-Agent": "app-tracking-update-client",
    };
    if (!this.#options.serviceMetrics) headers.DNT = "1";
    let cached;
    try {
      cached = release(state.release, this.#options, now);
    } catch {
      /* No usable conditional representation. */
    }
    if (cached && state.etag) headers["If-None-Match"] = state.etag;
    try {
      const connection = await request(
        new URL(this.#resource),
        "GET",
        headers,
        undefined,
        UPDATE_NETWORK_BUDGET_MS,
        signal,
      );
      try {
        const response = connection.response;
        const status = response.statusCode;
        let result;
        if (status === 200) {
          if (
            response.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          )
            throw new UpdateError("InvalidResponse");
          const body = await readBody(response, 16_384);
          try {
            result = release(strictJSON(body), this.#options, now);
          } catch {
            throw new UpdateError("InvalidResponse");
          }
        } else if (status === 304) {
          if (!cached) throw new UpdateError("InvalidResponse");
          result = cached;
        } else throw new UpdateError("HttpStatus", status);
        cancelled(signal);
        freshResponse(result, now);
        const etag = response.headers.etag;
        return {
          release: result,
          etag: validEtag(etag) ? etag : status === 304 ? state.etag : null,
        };
      } finally {
        connection.close();
      }
    } catch (e) {
      cancelled(signal);
      if (e instanceof UpdateError) throw e;
      throw new UpdateError("Network");
    }
  }
}
