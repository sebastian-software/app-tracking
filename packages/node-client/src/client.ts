import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import catalog from "../../../contracts/event-catalog.json" with { type: "json" };
import schema from "../../../contracts/telemetry-v1.schema.json" with { type: "json" };
import { canonical, record as object } from "../../../src/telemetry/contract.ts";
import { eventBatch, type EventCatalog } from "../../../src/telemetry/events.ts";
import { hash, projectIdentity, systemContext } from "./context.ts";
import { download } from "./download.ts";
import { endpoint, readBody, request } from "./transport.ts";
import {
  clear,
  closeBatch,
  DAY,
  directory,
  empty,
  lock,
  load,
  now,
  prune,
  random,
  save,
  statePath,
  type Job,
  type Lease,
  type State,
} from "./state.ts";
import {
  fail,
  TrackingError,
  type ClientOptions,
  type Dimensions,
  type DownloadOptions,
  type PermissionOutcome,
  type Recorded,
  type Resource,
  type Status,
} from "./types.ts";

declare const __WORKER_PATH__: string;
const definitions: EventCatalog = catalog.tools;
const truthy = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value !== "false";
const bool = (value: unknown) => {
  if (typeof value !== "boolean") fail("Configuration");
  return value;
};

export class Client {
  #options: ClientOptions;
  #directory: string;
  #scope: string;
  #metricScope: string;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #worker = false;
  #system?: Promise<Record<string, unknown> | undefined>;
  #project?: Promise<string | undefined>;

  /** Validate configuration only. No collection, filesystem access, or network. */
  constructor(options: ClientOptions) {
    if (
      !options ||
      typeof options.stateRoot !== "string" ||
      !isAbsolute(options.stateRoot) ||
      !Object.hasOwn(definitions, options.tool) ||
      typeof options.version !== "string" ||
      options.version.length > 128 ||
      !new RegExp(schema.$defs.row.properties.tool_version.pattern).test(options.version)
    )
      fail("Configuration");
    const origin = endpoint(options.origin, true).origin;
    if (options.interaction !== undefined && !["never", "terminal"].includes(options.interaction))
      fail("Configuration");
    if (options.projectContext !== undefined && typeof options.projectContext !== "function")
      fail("Configuration");
    const policy = { ...options.policy };
    for (const key of ["offline", "ci", "isolatedCiState", "doNotTrack", "hostDisabled"] as const)
      if (policy[key] !== undefined) bool(policy[key]);
    const envTelemetry = process.env.APP_TRACKING_TELEMETRY;
    policy.telemetry =
      envTelemetry !== undefined && envTelemetry !== "on"
        ? envTelemetry
        : (policy.telemetry ?? envTelemetry);
    policy.doNotTrack = truthy(process.env.DO_NOT_TRACK) || policy.doNotTrack === true;
    policy.ci =
      truthy(process.env.CI) || truthy(process.env.CONTINUOUS_INTEGRATION) || policy.ci === true;
    policy.ciRevision = process.env.APP_TRACKING_CI ?? policy.ciRevision;
    this.#options = { ...options, origin, policy, interaction: options.interaction ?? "terminal" };
    this.#scope = `${origin}\n${options.tool}\n${policy.ci ? "ci" : "local"}`;
    this.#metricScope = hash(canonical(definitions[options.tool]));
    this.#directory = join(
      options.stateRoot,
      hash(origin),
      options.tool,
      "node-events-v1",
      ...(policy.ci ? ["ci"] : []),
    );
  }

  #veto(): boolean {
    const p = this.#options.policy!;
    return !!(
      p.doNotTrack ||
      p.hostDisabled ||
      (p.telemetry !== undefined && p.telemetry !== "on") ||
      (p.ci && (!p.isolatedCiState || p.ciRevision !== "telemetry-v1"))
    );
  }
  #allowed(state: State): boolean {
    const id = state.identity;
    const at = now();
    return (
      !this.#veto() &&
      !state.disabled &&
      !state.deleting &&
      state.optIn === true &&
      state.optInScope === this.#metricScope &&
      id !== null &&
      at >= Math.max(id.consentedAt, id.lastAcceptedAt) &&
      at - Math.max(id.consentedAt, id.lastAcceptedAt) < 90 * DAY
    );
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#pending >= 256) return Promise.reject(new TrackingError("Busy"));
    this.#pending++;
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {
        this.#pending--;
      },
      () => {
        this.#pending--;
      },
    );
    return result;
  }
  async #state<T>(
    create: boolean,
    action: (state: State | undefined) => T | Promise<T>,
    waitForLock = false,
  ): Promise<T> {
    if (!(await directory(this.#directory, create))) return action(undefined);
    const release = await this.#lock(statePath(this.#directory), waitForLock);
    try {
      const state = await load(
        statePath(this.#directory),
        this.#scope,
        this.#options.tool,
        this.#metricScope,
      );
      const result = await action(state);
      release.check();
      await save(statePath(this.#directory), state);
      return result;
    } finally {
      await release();
    }
  }
  async #lock(path: string, wait = false): Promise<Lease> {
    const deadline = performance.now() + (this.#worker || wait ? 500 : 0);
    for (;;) {
      try {
        return await lock(path);
      } catch (error) {
        if (
          !(error instanceof TrackingError) ||
          error.code !== "Busy" ||
          performance.now() >= deadline
        )
          throw error;
        // Workers and prompt claims wait briefly for foreground state writes.
        await delay(5);
      }
    }
  }
  async #network<T>(
    create: boolean,
    action: (check: () => void) => Promise<T>,
    absent: T,
  ): Promise<T> {
    if (!(await directory(this.#directory, create))) return absent;
    const release = await this.#lock(join(this.#directory, "network"));
    try {
      return await action(release.check);
    } finally {
      await release();
    }
  }
  #inspect(state: State | undefined): State {
    const value = state ?? empty(this.#scope);
    prune(value, now());
    if (!value.deleting && !this.#allowed(value)) clear(value);
    return value;
  }
  status(): Promise<Status> {
    return this.#queue(() =>
      this.#state(false, (stored) => {
        const state = this.#inspect(stored);
        return {
          decision: state.optIn === null ? "undecided" : state.optIn ? "granted" : "declined",
          optIn: state.optIn === true,
          collectOptIn: this.#allowed(state),
          disabled: state.disabled,
          deletionPending: state.deleting,
          openDimensions: Object.keys(state.open).length,
          queuedBatches: state.batches.length,
          dropped: state.dropped,
        };
      }),
    );
  }
  /** Inspect unsent data; reporting credentials never appear in this value. */
  preview(): Promise<{ open: unknown[]; batches: unknown[] }> {
    return this.#queue(() =>
      this.#state(false, (stored) => {
        const state = this.#inspect(stored);
        return {
          open: Object.values(state.open),
          batches: state.batches.map((batch) => JSON.parse(batch.body)),
        };
      }),
    );
  }
  #choice(state: State, enabled: boolean): void {
    if (
      enabled &&
      (state.deleting ||
        (state.identity &&
          now() - Math.max(state.identity.consentedAt, state.identity.lastAcceptedAt) >= 90 * DAY))
    )
      fail("PreviousIdentity");
    if (state.optIn === enabled && (!enabled || state.optInScope === this.#metricScope)) return;
    state.optIn = enabled;
    state.optInScope = enabled ? this.#metricScope : null;
    state.generation++;
    state.job = null;
    if (enabled)
      state.identity ??= { id: random(), token: random(), consentedAt: now(), lastAcceptedAt: 0 };
    else clear(state);
  }
  /** Call only after an explicit informed human settings choice. */
  setOptIn(enabled: boolean): Promise<void> {
    return this.#queue(async () => {
      bool(enabled);
      await this.#network(
        true,
        () => this.#state(true, (state) => this.#choice(state!, enabled)),
        undefined,
      );
    });
  }
  setDisabled(disabled: boolean): Promise<void> {
    return this.#queue(async () => {
      bool(disabled);
      await this.#network(
        true,
        () =>
          this.#state(true, (state) => {
            state!.disabled = disabled;
            state!.generation++;
            state!.job = null;
            if (disabled) clear(state!);
          }),
        undefined,
      );
    });
  }
  /** Disable collection, discard unsent data, and queue authenticated deletion. */
  delete(): Promise<void> {
    return this.#queue(() =>
      this.#network(
        true,
        () =>
          this.#state(true, (state) => {
            state!.optIn = false;
            state!.optInScope = null;
            state!.disabled = true;
            clear(state!);
            state!.deleting = state!.identity !== null;
            state!.generation++;
            state!.nextAttempt = 0;
          }),
        undefined,
      ),
    );
  }
  #permission(state: State | undefined): PermissionOutcome | undefined {
    if (!state) return;
    if (state.disabled || state.deleting) return "unavailable";
    if (state.optIn === false) return "declined";
    if (state.optIn === true && state.optInScope === this.#metricScope)
      return this.#allowed(state) ? "granted" : "unavailable";
  }
  async requestOptIn(reason: string): Promise<PermissionOutcome> {
    return this.#requestOptIn(reason, false);
  }
  /** Offer yes, later (default), or never, at most once every 14 days. */
  async requestOptInReminder(reason: string): Promise<PermissionOutcome> {
    return this.#requestOptIn(reason, true);
  }
  async #requestOptIn(reason: string, reminder: boolean): Promise<PermissionOutcome> {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      Buffer.byteLength(reason) > 4096 ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(reason)
    )
      fail("Configuration");
    if (this.#veto() || this.#worker || !isMainThread) return "unavailable";
    let saved = await this.#queue(() =>
      this.#state(
        false,
        (state) => ({
          answer: this.#permission(state),
          generation: state?.generation ?? 0,
        }),
        reminder,
      ),
    );
    if (saved.answer) return saved.answer;
    if (
      this.#options.interaction === "never" ||
      this.#options.policy!.ci ||
      !process.stdin.isTTY ||
      !process.stderr.isTTY
    )
      return "unavailable";
    if (reminder) {
      const claimed = await this.#queue(() =>
        this.#state(
          true,
          (state) => {
            const answer = this.#permission(state);
            if (answer) return { answer, generation: state!.generation };
            const at = now();
            const last = state!.lastPermissionPromptAt;
            if (last !== undefined && (at < last || at - last < 14 * DAY))
              return { answer: "unavailable" as PermissionOutcome, generation: state!.generation };
            state!.lastPermissionPromptAt = at;
            return { answer: undefined, generation: state!.generation };
          },
          true,
        ),
      );
      if (claimed.answer) return claimed.answer;
      saved = claimed;
    }
    const metrics = Object.entries(definitions[this.#options.tool])
      .map(([id, definition]) => `  ${id} (${Object.keys(definition.dimensions).join(", ")})`)
      .join("\n");
    const prompt = `${reminder ? `\nIs ${this.#options.tool} working well for you?\nYou can help shape its next improvements by sharing optional usage statistics.\n` : ""}\nOptional usage reporting for ${this.#options.tool}\n\n${reason.trim()}\n\nData: usage counts, tool version, and a random reporting ID for this tool/profile.\n${metrics}\nAlso: bounded OS/version, executable architecture, and CPU family.\nWhen supplied: SHA-256 of the normalized repository URL, which can be guessed from a known URL.\nYour answer is saved for this tool/profile and can be changed in settings.\n\n${reminder ? "Your choice does not affect how you use the tool. You can change it in settings.\n\nWould you like to share optional usage statistics?\n  yes    Allow optional usage reporting\n  later  Ask again in 14 days (default: later)\n  never  Do not ask again\n\nYour choice [later]:" : "Allow optional usage reporting? [y/N]"} `;
    const answer = reminder
      ? await new Promise<boolean | undefined>((resolve) => {
          let buffer = Buffer.alloc(0);
          const finish = (answer: boolean | undefined) => {
            process.stdin.off("data", onData);
            process.stdin.off("end", onEnd);
            process.stdin.pause();
            resolve(answer);
          };
          const onEnd = () => finish(undefined);
          const onData = (chunk: Buffer | string) => {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            for (;;) {
              const newline = buffer.indexOf(10);
              if (newline < 0) {
                if (buffer.length > 256) finish(undefined);
                return;
              }
              if (newline + 1 > 256) {
                finish(undefined);
                return;
              }
              const value = buffer.subarray(0, newline).toString("utf8").trim().toLowerCase();
              buffer = buffer.subarray(newline + 1);
              if (value === "y" || value === "yes") return finish(true);
              if (value === "n" || value === "no" || value === "never") return finish(false);
              if (value === "" || value === "l" || value === "later") return finish(undefined);
              process.stderr.write("Please choose yes, later, or never: ");
            }
          };
          process.stdin.on("data", onData);
          process.stdin.once("end", onEnd);
          process.stderr.write(prompt);
          process.stdin.resume();
        })
      : await new Promise<boolean | undefined>((resolve) => {
          const terminal = createInterface({ input: process.stdin, output: process.stderr });
          terminal.once("close", () => resolve(undefined));
          terminal.once("SIGINT", () => terminal.close());
          terminal.question(prompt, (input) => {
            const value = input.trim().toLowerCase();
            resolve(
              value === "y" || value === "yes"
                ? true
                : value === "" || value === "n" || value === "no"
                  ? false
                  : undefined,
            );
            terminal.close();
          });
        });
    if (answer === undefined) return "unavailable";
    return this.#queue(() =>
      this.#network(
        true,
        () =>
          this.#state(true, (state) => {
            if (!answer && !state!.disabled && !state!.deleting) {
              this.#choice(state!, false);
              return "declined";
            }
            const current = this.#permission(state);
            if (current) return current;
            if (state!.generation !== saved.generation) return "unavailable";
            this.#choice(state!, answer);
            return answer ? "granted" : "declined";
          }),
        "unavailable" as PermissionOutcome,
      ),
    );
  }
  record(metric: string, dimensions: Dimensions = {}): Promise<Recorded> {
    return this.#queue(async () => {
      const definition = definitions[this.#options.tool][metric];
      if (!Object.hasOwn(definitions[this.#options.tool], metric)) fail("Configuration");
      if (this.#veto()) return "suppressed";
      return this.#state(false, async (state) => {
        if (!state || !this.#allowed(state)) return "suppressed";
        if (
          !object(dimensions) ||
          Object.keys(dimensions).length !== Object.keys(definition.dimensions).length ||
          Object.entries(definition.dimensions).some(
            ([key, allowed]) =>
              typeof dimensions[key] !== "string" || !allowed.includes(dimensions[key]),
          )
        )
          fail("Configuration");
        const timestamp = now();
        const day = Math.floor(timestamp / DAY);
        if (
          Object.values(state.open).some((row) => Number(row.day) > day) ||
          state.batches.some((batch) => batch.day > day)
        )
          fail("Clock");
        prune(state, timestamp);
        const system = await (this.#system ??= systemContext(definition.system));
        let project: string | undefined;
        if (definition.project && this.#options.projectContext) {
          const source = this.#options.projectContext;
          project = await (this.#project ??= Promise.resolve()
            .then(source)
            .then(projectIdentity)
            .catch(() => undefined));
        }
        const row = {
          day,
          metric,
          collection: "opt_in",
          tool_version: this.#options.version,
          dimensions: { ...dimensions },
          ...(system ? { system } : {}),
          ...(project ? { project_id: project, project_id_version: 1 } : {}),
        };
        const key = hash(canonical(row));
        const total = Object.values(state.open)
          .filter((r) => r.day === day)
          .reduce((sum, r) => sum + Number(r.count), 0);
        if (
          total >= 10_000_000 ||
          Number(state.open[key]?.count ?? 0) >= 1_000_000 ||
          (!Object.hasOwn(state.open, key) && Object.keys(state.open).length >= 4096)
        ) {
          state.dropped++;
          return "capacityReached";
        }
        state.open[key] = { ...row, count: Number(state.open[key]?.count ?? 0) + 1 };
        return "counted";
      });
    });
  }
  async download(resource: Resource, options: DownloadOptions = {}) {
    const result = await download(resource, options, this.#options.policy!.offline === true);
    if (resource.reporting)
      await this.record(resource.reporting.metric, resource.reporting.dimensions).catch(() => {});
    return result;
  }

  async #schedule(): Promise<Job | undefined> {
    if (this.#options.policy!.offline) return;
    return this.#network(
      false,
      () =>
        this.#state(false, (state) => {
          if (!state) return;
          const timestamp = now();
          prune(state, timestamp);
          if (timestamp < state.nextAttempt) return;
          if (!state.deleting) {
            if (!this.#allowed(state)) {
              clear(state);
              return;
            }
            if (!state.batches.length)
              closeBatch(state, this.#options.tool, this.#options.policy!.ci === true);
            if (!state.batches.length) return;
          }
          const job = {
            nonce: random(),
            generation: state.generation,
            created: timestamp,
            batch: state.deleting ? "delete" : state.batches[0].id,
          };
          state.job = job;
          state.nextAttempt = timestamp + 60_000;
          return job;
        }),
      undefined,
    );
  }
  /** Resolve after a bounded worker is launched, without waiting for delivery. */
  flushInBackground(): Promise<boolean> {
    return this.#queue(async () => {
      const job = await this.#schedule();
      if (!job) return false;
      const { projectContext: _project, ...options } = this.#options;
      const handoff = JSON.stringify({
        options: { ...options, interaction: "never" },
        nonce: job.nonce,
      });
      if (Buffer.byteLength(handoff) > 16_384) fail("Background");
      const environment: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [__WORKER_PATH__], {
            detached: true,
            windowsHide: true,
            stdio: ["pipe", "ignore", "ignore"],
            env: environment,
          });
          child.once("error", reject);
          child.stdin.on("error", reject);
          child.once("spawn", () =>
            child.stdin.end(handoff, () => {
              child.unref();
              resolve();
            }),
          );
        });
        return true;
      } catch {
        fail("Background");
      }
    });
  }

  /** @internal Dedicated package worker only; a nonce never authorizes new data. */
  async runBackgroundWorker(nonce: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(nonce)) fail("Configuration");
    if (this.#options.policy!.offline) return false;
    this.#worker = true;
    return this.#network(
      false,
      async (check) => {
        const prepared = await this.#state(false, (state) => {
          const job = state?.job;
          if (!state || !job || job.nonce !== nonce) return;
          state.job = null;
          const timestamp = now();
          if (
            job.generation !== state.generation ||
            timestamp < job.created ||
            timestamp - job.created > 30_000
          )
            return;
          if (job.batch !== "delete" && !this.#allowed(state)) return;
          if (job.batch === "delete" && !state.deleting) return;
          const batch = state.batches.find((b) => b.id === job.batch);
          if (job.batch !== "delete" && !batch) return;
          return { identity: state.identity!, batch, job, timestamp };
        });
        if (!prepared) return false;
        check();
        const { identity, batch, job, timestamp } = prepared;
        let accepted = false;
        try {
          const deleting = job.batch === "delete";
          const path = deleting ? `/v1/event-installations/${identity.id}` : "/v1/event-batches";
          const connection = await request(
            new URL(path, this.#options.origin),
            deleting ? "DELETE" : "POST",
            {
              Authorization: `Bearer ${identity.token}`,
              "App-Tracking-Tool": this.#options.tool,
              Accept: "application/json",
              "Content-Type": "application/json",
              "Accept-Encoding": "identity",
            },
            batch?.body,
            5000,
          );
          try {
            const response = connection.response;
            const text = await readBody(response, 2048);
            if (response.headers["cache-control"] === "no-store") {
              if (deleting)
                accepted =
                  (response.statusCode === 204 && text === "") ||
                  (response.statusCode === 404 &&
                    JSON.parse(text)?.error?.code === "installation_not_found");
              else if (response.statusCode === 200) {
                const receipt = JSON.parse(text);
                accepted =
                  object(receipt) &&
                  Object.keys(receipt).sort().join() === "batch_id,payload_sha256" &&
                  receipt.batch_id === batch!.id &&
                  receipt.payload_sha256 === batch!.sha256;
              }
            }
          } finally {
            connection.close();
          }
        } catch {
          /* The immutable batch and identity remain available for retry. */
        }
        check();
        await this.#state(false, (state) => {
          if (!state || state.generation !== job.generation) return;
          if (accepted) {
            state.failures = 0;
            if (job.batch === "delete") {
              state.identity = null;
              state.deleting = false;
            } else {
              state.batches = state.batches.filter((pending) => pending.id !== batch!.id);
              state.identity!.lastAcceptedAt = timestamp;
            }
            state.nextAttempt =
              timestamp + (state.batches.length || Object.keys(state.open).length ? 60_000 : DAY);
          } else {
            state.failures++;
            state.nextAttempt =
              timestamp +
              [60, 300, 1800, 3600, 21600, 86400][Math.min(state.failures - 1, 5)] * 1000;
          }
        });
        return accepted;
      },
      false,
    ).finally(() => {
      this.#worker = false;
    });
  }
}
