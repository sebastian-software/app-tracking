import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { isMainThread } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import catalog from "../../../contracts/event-catalog.json" with { type: "json" };
import schema from "../../../contracts/telemetry-v1.schema.json" with { type: "json" };
import { canonical, record as object } from "../../../src/telemetry/contract.ts";
import { eventBatch, type EventCatalog } from "../../../src/telemetry/events.ts";
import { strictJSON } from "../../../src/telemetry/json.ts";
import { hash, projectIdentity, systemContext } from "./context.ts";
import { download } from "./download.ts";
import { withProfile } from "./profile.ts";
import { PROFILE_CONSENT_REVISION, PROFILE_NOTICE } from "./permissions.ts";
import {
  HISTORY_CONSENT_REVISION,
  HISTORY_NOTICE,
  PUBLIC_USAGE_CONSENT_REVISION,
  PUBLIC_USAGE_NOTICE,
} from "./permissions.ts";
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
  type AdditionalPermissionStatus,
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
      (options.sharedProfileRoot !== undefined &&
        (typeof options.sharedProfileRoot !== "string" ||
          !isAbsolute(options.sharedProfileRoot))) ||
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
    else {
      this.#withdrawAdditional(state, "history");
      this.#withdrawProfile(state);
      clear(state);
    }
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
            if (disabled) {
              this.#withdrawAdditional(state!, "history");
              this.#withdrawProfile(state!);
              clear(state!);
            }
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
            this.#withdrawAdditional(state!, "history");
            this.#withdrawProfile(state!);
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
      !isMainThread ||
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
  #revision(kind: "history" | "publicUsage"): string {
    return kind === "history" ? HISTORY_CONSENT_REVISION : PUBLIC_USAGE_CONSENT_REVISION;
  }
  #withdrawAdditional(state: State, kind: "history" | "publicUsage"): void {
    if (kind === "history") this.#withdrawAdditional(state, "publicUsage");
    const choice = state[kind];
    if (choice?.enabled) {
      choice.enabled = false;
      choice.revision = this.#revision(kind);
      choice.changedAt = Math.max(now(), choice.changedAt + 1);
      choice.confirmed = false;
    }
  }
  #additionalAllowed(state: State, kind: "history" | "publicUsage"): boolean {
    return (
      this.#allowed(state) &&
      (kind === "history" ||
        (state.history?.enabled === true && state.history.revision === HISTORY_CONSENT_REVISION))
    );
  }
  #setAdditional(state: State, kind: "history" | "publicUsage", enabled: boolean): void {
    if (enabled && !this.#additionalAllowed(state, kind)) fail("AdditionalPermission");
    const choice = state[kind];
    const timestamp = now();
    if (
      choice &&
      choice.enabled === enabled &&
      (!enabled || choice.revision === this.#revision(kind)) &&
      (choice.confirmed || Math.max(0, timestamp - choice.changedAt) < 90 * DAY)
    )
      return;
    if (!enabled && kind === "history") this.#withdrawAdditional(state, "publicUsage");
    state[kind] = {
      revision: this.#revision(kind),
      enabled,
      changedAt: Math.max(timestamp, (choice?.changedAt ?? -1) + 1),
      confirmed: state.identity === null,
    };
    state.generation++;
    state.job = null;
  }
  #setAdditionalPermission(kind: "history" | "publicUsage", enabled: boolean): Promise<void> {
    bool(enabled);
    return this.#queue(() =>
      this.#network(
        true,
        () => this.#state(true, (state) => this.#setAdditional(state!, kind, enabled)),
        undefined,
      ),
    );
  }
  setHistoryOptIn(enabled: boolean): Promise<void> {
    return this.#setAdditionalPermission("history", enabled);
  }
  setPublicUsageOptIn(enabled: boolean): Promise<void> {
    return this.#setAdditionalPermission("publicUsage", enabled);
  }
  #additionalStatus(kind: "history" | "publicUsage"): Promise<AdditionalPermissionStatus> {
    return this.#queue(() =>
      this.#state(false, (state) => {
        const choice = state?.[kind];
        return {
          decision:
            !choice || (choice.enabled && choice.revision !== this.#revision(kind))
              ? "undecided"
              : choice.enabled
                ? "granted"
                : "declined",
          pending: !!choice && !choice.confirmed,
        };
      }),
    );
  }
  historyStatus(): Promise<AdditionalPermissionStatus> {
    return this.#additionalStatus("history");
  }
  publicUsageStatus(): Promise<AdditionalPermissionStatus> {
    return this.#additionalStatus("publicUsage");
  }
  async #requestAdditional(
    kind: "history" | "publicUsage",
    reason: string,
  ): Promise<PermissionOutcome> {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      Buffer.byteLength(reason) > 4096 ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(reason)
    )
      fail("Configuration");
    const saved = await this.#queue(() =>
      this.#state(false, (state) => {
        if (!state || !this.#additionalAllowed(state, kind) || this.#worker || !isMainThread)
          return { answer: "unavailable" as PermissionOutcome, generation: 0 };
        const choice = state[kind];
        const answer: PermissionOutcome | undefined = !choice
          ? undefined
          : !choice.enabled
            ? "declined"
            : choice.revision === this.#revision(kind) &&
                (choice.confirmed || Math.max(0, now() - choice.changedAt) < 90 * DAY)
              ? "granted"
              : undefined;
        return { answer, generation: state.generation };
      }),
    );
    if (saved.answer) return saved.answer;
    if (
      this.#options.interaction === "never" ||
      !isMainThread ||
      this.#options.policy!.ci ||
      !process.stdin.isTTY ||
      !process.stderr.isTTY
    )
      return "unavailable";
    const notice = kind === "history" ? HISTORY_NOTICE : PUBLIC_USAGE_NOTICE;
    const prompt = `\nOptional ${kind === "history" ? "monthly summaries" : "public usage totals"} for ${this.#options.tool}\n\n${reason.trim()}\n\n${notice}\n\nAllow? [y/N] `;
    const answer = await new Promise<boolean | undefined>((resolve) => {
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
        false,
        () =>
          this.#state(false, (state) => {
            if (
              !state ||
              !this.#additionalAllowed(state, kind) ||
              (answer && state.generation !== saved.generation)
            )
              return "unavailable";
            this.#setAdditional(state, kind, answer);
            return answer ? "granted" : "declined";
          }),
        "unavailable" as PermissionOutcome,
      ),
    );
  }
  requestHistoryOptIn(reason: string): Promise<PermissionOutcome> {
    return this.#requestAdditional("history", reason);
  }
  requestPublicUsageOptIn(reason: string): Promise<PermissionOutcome> {
    return this.#requestAdditional("publicUsage", reason);
  }
  #syncAdditional(kind: "history" | "publicUsage"): Promise<boolean> {
    return this.#queue(async () => {
      if (this.#options.policy!.offline) return false;
      return this.#network(
        false,
        async (check) => {
          const prepared = await this.#state(false, (state) => {
            const choice = state?.[kind];
            if (!state || !choice || (choice.enabled && choice.revision !== this.#revision(kind)))
              return;
            if (choice.confirmed) return { confirmed: true as const };
            if (
              (choice.enabled &&
                (!this.#additionalAllowed(state, kind) ||
                  Math.max(0, now() - choice.changedAt) >= 90 * DAY)) ||
              !state.identity
            )
              return;
            return {
              confirmed: false as const,
              choice: { ...choice },
              identity: { ...state.identity },
              generation: state.generation,
            };
          });
          if (!prepared) return false;
          if (prepared.confirmed) return true;
          const body = JSON.stringify({
            schema_version: 1,
            revision: this.#revision(kind),
            enabled: prepared.choice.enabled,
            changed_at: prepared.choice.changedAt,
          });
          let accepted = false;
          try {
            check();
            const path = kind === "history" ? "history-permissions" : "public-permissions";
            const connection = await request(
              new URL(`/v1/${path}/events/${prepared.identity.id}`, this.#options.origin),
              "PUT",
              {
                Authorization: `Bearer ${prepared.identity.token}`,
                "App-Tracking-Tool": this.#options.tool,
                "Content-Type": "application/json",
                "Accept-Encoding": "identity",
              },
              body,
              5000,
            );
            try {
              const response = connection.response;
              const text = await readBody(response, 2048);
              const receipt: unknown = strictJSON(text);
              accepted =
                response.statusCode === 200 &&
                response.headers["cache-control"] === "no-store" &&
                object(receipt) &&
                Object.keys(receipt).sort().join() ===
                  "changed_at,enabled,revision,schema_version" &&
                receipt.schema_version === 1 &&
                receipt.revision === this.#revision(kind) &&
                receipt.enabled === prepared.choice.enabled &&
                receipt.changed_at === prepared.choice.changedAt;
            } finally {
              connection.close();
            }
          } catch {
            /* Keep pending on network or receipt failure. */
          }
          check();
          if (!accepted) return false;
          return this.#state(false, (state) => {
            const choice = state?.[kind];
            if (
              !state ||
              state.generation !== prepared.generation ||
              !choice ||
              choice.changedAt !== prepared.choice.changedAt ||
              choice.enabled !== prepared.choice.enabled ||
              choice.revision !== prepared.choice.revision
            )
              return false;
            choice.confirmed = true;
            return true;
          });
        },
        false,
      );
    });
  }
  syncHistoryPermission(): Promise<boolean> {
    return this.#syncAdditional("history");
  }
  syncPublicUsagePermission(): Promise<boolean> {
    return this.#syncAdditional("publicUsage");
  }
  #withdrawProfile(state: State): void {
    const choice = state.profile;
    if (choice?.enabled)
      state.profile = {
        revision: PROFILE_CONSENT_REVISION,
        enabled: false,
        changedAt: Math.max(now(), choice.changedAt + 1),
        confirmed: !state.identity,
        profileId: null,
      };
  }
  #profileRoot(): string {
    if (!this.#options.sharedProfileRoot) fail("Configuration");
    return this.#options.sharedProfileRoot;
  }
  async #saveProfileChoice(state: State, enabled: boolean): Promise<void> {
    if (enabled && !this.#allowed(state)) fail("AdditionalPermission");
    let id: string | null = null;
    if (enabled)
      await withProfile(this.#profileRoot(), this.#options.origin, true, async (profile) => {
        if (!profile) fail("State");
        if (profile.reset_pending) fail("PreviousIdentity");
        id = profile.profile_id;
      });
    const old = state.profile;
    const at = now();
    if (
      old &&
      old.revision === PROFILE_CONSENT_REVISION &&
      old.enabled === enabled &&
      old.profileId === id &&
      (old.confirmed || Math.max(0, at - old.changedAt) < 90 * DAY)
    )
      return;
    state.profile = {
      revision: PROFILE_CONSENT_REVISION,
      enabled,
      changedAt: Math.max(at, (old?.changedAt ?? -1) + 1),
      confirmed: !state.identity,
      profileId: id,
    };
    state.generation++;
    state.job = null;
  }
  setProfileLinking(enabled: boolean): Promise<void> {
    return this.#queue(async () => {
      bool(enabled);
      if (this.#options.policy!.ci) fail("AdditionalPermission");
      await this.#network(
        true,
        () =>
          this.#state(true, async (state) => {
            if (!state) fail("AdditionalPermission");
            await this.#saveProfileChoice(state, enabled);
          }),
        undefined,
      );
    });
  }
  profileStatus(): Promise<import("./types.ts").ProfilePermissionStatus> {
    return this.#queue(async () => {
      const empty = { decision: "undecided" as const, pending: false, resetPending: false };
      if (this.#options.policy!.ci) return empty;
      return this.#state(false, async (state) => {
        const choice = state?.profile;
        if (!choice || !choice.enabled)
          return {
            decision: choice ? "declined" : "undecided",
            pending: !!choice && !choice.confirmed,
            resetPending: false,
          };
        return withProfile(this.#profileRoot(), this.#options.origin, false, async (profile) => {
          const resetPending = profile?.reset_pending === true;
          const matches =
            !!profile &&
            !resetPending &&
            choice.revision === PROFILE_CONSENT_REVISION &&
            choice.profileId === profile.profile_id &&
            (choice.confirmed || Math.max(0, now() - choice.changedAt) < 90 * DAY);
          return {
            decision: matches ? "granted" : "undecided",
            pending: !choice.confirmed || resetPending,
            resetPending,
          };
        });
      });
    });
  }
  async requestProfileLinking(reason: string): Promise<PermissionOutcome> {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      Buffer.byteLength(reason) > 4096 ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(reason)
    )
      fail("Configuration");
    if (
      this.#options.policy!.ci ||
      !this.#options.sharedProfileRoot ||
      this.#worker ||
      !isMainThread
    )
      return "unavailable";
    const saved = await this.#queue(() =>
      this.#state(false, (state) => ({
        allowed: !!state && this.#allowed(state),
        generation: state?.generation ?? 0,
      })),
    );
    if (!saved.allowed) return "unavailable";
    const status = await this.profileStatus();
    if (status.decision === "declined" || status.decision === "granted") return status.decision;
    if (
      status.resetPending ||
      this.#options.interaction === "never" ||
      !process.stdin.isTTY ||
      !process.stderr.isTTY
    )
      return "unavailable";
    const answer = await new Promise<boolean | undefined>((resolve) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      terminal.once("close", () => resolve(undefined));
      terminal.once("SIGINT", () => terminal.close());
      terminal.question(
        `\nOptional cross-tool profile linking for ${this.#options.tool}\n\n${reason.trim()}\n\n${PROFILE_NOTICE}\n\nAllow profile linking? [y/N] `,
        (input) => {
          const v = input.trim().toLowerCase();
          resolve(
            v === "y" || v === "yes"
              ? true
              : v === "" || v === "n" || v === "no"
                ? false
                : undefined,
          );
          terminal.close();
        },
      );
    });
    if (answer === undefined) return "unavailable";
    return this.#queue(() =>
      this.#network(
        false,
        () =>
          this.#state(false, async (state) => {
            if (
              !state ||
              !this.#allowed(state) ||
              (answer && state.generation !== saved.generation)
            )
              return "unavailable";
            await this.#saveProfileChoice(state, answer);
            return answer ? "granted" : "declined";
          }),
        "unavailable" as PermissionOutcome,
      ),
    );
  }
  syncProfileLinking(): Promise<boolean> {
    return this.#queue(async () => {
      if (this.#options.policy!.offline || this.#options.policy!.ci) return false;
      return this.#network(
        false,
        () =>
          this.#state(false, async (state) => {
            const choice = state?.profile;
            if (
              !state ||
              !choice ||
              !state.identity ||
              (choice.enabled &&
                (choice.revision !== PROFILE_CONSENT_REVISION ||
                  !this.#allowed(state) ||
                  (!choice.confirmed && Math.max(0, now() - choice.changedAt) >= 90 * DAY)))
            )
              return false;
            const send = async (
              profile?: import("./profile.ts").SharedProfile,
              save?: () => Promise<void>,
            ) => {
              if (
                choice.enabled &&
                (!profile || profile.reset_pending || profile.profile_id !== choice.profileId)
              )
                return false;
              if (choice.confirmed) return true;
              if (profile) {
                profile.link_attempted = true;
                await save!();
              }
              const body = JSON.stringify({
                schema_version: 1,
                revision: PROFILE_CONSENT_REVISION,
                enabled: choice.enabled,
                changed_at: choice.changedAt,
                profile_id: choice.profileId,
                profile_token: profile?.token ?? null,
              });
              try {
                const connection = await request(
                  new URL(`/v1/profile-links/events/${state.identity!.id}`, this.#options.origin),
                  "PUT",
                  {
                    Authorization: `Bearer ${state.identity!.token}`,
                    "App-Tracking-Tool": this.#options.tool,
                    "Content-Type": "application/json",
                    "Accept-Encoding": "identity",
                  },
                  body,
                  5000,
                );
                try {
                  const response = connection.response;
                  const receipt: unknown = strictJSON(await readBody(response, 2048));
                  if (
                    response.statusCode !== 200 ||
                    response.headers["cache-control"] !== "no-store" ||
                    !object(receipt) ||
                    Object.keys(receipt).sort().join() !==
                      "changed_at,enabled,profile_id,revision,schema_version" ||
                    receipt.schema_version !== 1 ||
                    receipt.revision !== PROFILE_CONSENT_REVISION ||
                    receipt.enabled !== choice.enabled ||
                    receipt.changed_at !== choice.changedAt ||
                    receipt.profile_id !== choice.profileId
                  )
                    return false;
                  choice.confirmed = true;
                  return true;
                } finally {
                  connection.close();
                }
              } catch {
                return false;
              }
            };
            return choice.enabled
              ? withProfile(this.#profileRoot(), this.#options.origin, false, send)
              : send();
          }),
        false,
      );
    });
  }
  profileResetPending(): Promise<boolean> {
    return this.#queue(async () =>
      this.#options.policy!.ci || !this.#options.sharedProfileRoot
        ? false
        : withProfile(
            this.#profileRoot(),
            this.#options.origin,
            false,
            async (p) => p?.reset_pending === true,
          ),
    );
  }
  requestProfileReset(): Promise<void> {
    return this.#queue(async () => {
      if (this.#options.policy!.ci) fail("AdditionalPermission");
      await withProfile(this.#profileRoot(), this.#options.origin, false, async (p, save) => {
        if (p) {
          p.reset_pending = true;
          await save();
        }
      });
    });
  }
  syncProfileReset(): Promise<boolean> {
    return this.#queue(async () => {
      if (this.#options.policy!.ci) return false;
      return withProfile(this.#profileRoot(), this.#options.origin, false, async (p, save) => {
        if (!p) return false;
        if (!p.reset_pending) return true;
        if (!p.link_attempted) {
          p.profile_id = random();
          p.token = random();
          p.reset_pending = false;
          await save();
          return true;
        }
        if (this.#options.policy!.offline) return false;
        try {
          const connection = await request(
            new URL(`/v1/shared-profiles/${p.profile_id}`, this.#options.origin),
            "DELETE",
            { Authorization: `Bearer ${p.token}`, "Accept-Encoding": "identity" },
            undefined,
            5000,
          );
          try {
            const response = connection.response;
            const receipt: unknown = strictJSON(await readBody(response, 2048));
            if (
              response.statusCode !== 200 ||
              response.headers["cache-control"] !== "no-store" ||
              !object(receipt) ||
              Object.keys(receipt).sort().join() !== "profile_id,revision,schema_version,status" ||
              receipt.schema_version !== 1 ||
              receipt.revision !== PROFILE_CONSENT_REVISION ||
              receipt.status !== "deleted" ||
              receipt.profile_id !== p.profile_id
            )
              return false;
            p.profile_id = random();
            p.token = random();
            p.reset_pending = false;
            p.link_attempted = false;
            await save();
            return true;
          } finally {
            connection.close();
          }
        } catch {
          return false;
        }
      });
    });
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
