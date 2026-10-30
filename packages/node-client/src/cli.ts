import catalog from "../../../contracts/event-catalog.json" with { type: "json" };
import type { EventCatalog } from "../../../src/telemetry/events.ts";
import { Client } from "./client.ts";
import { resolvePolicy } from "./policy.ts";
import {
  fail,
  TrackingError,
  type AdditionalPermissionStatus,
  type ClientOptions,
  type Dimensions,
  type PermissionOutcome,
  type ProfilePermissionStatus,
  type Recorded,
  type Status,
} from "./types.ts";
import { UpdateClient, UpdateError, type Update, type UpdateMode } from "./update.ts";

export interface CliClientOptions extends ClientOptions {
  invocation: {
    metric: string;
    /** Host command categories mapped to the registered metric dimensions. */
    categories: Readonly<Record<string, Dimensions>>;
  };
  updates?: {
    cacheRoot: string;
    distribution: string;
    channel?: string;
    mode: UpdateMode;
    serviceMetrics?: boolean;
  };
}
export interface CliStatus {
  reporting: Status;
  history: AdditionalPermissionStatus;
  publicUsage: AdditionalPermissionStatus;
  profile: ProfilePermissionStatus;
}
export type AdvisoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TrackingError | UpdateError };
export type InvocationRecorded = Recorded | "alreadyRecorded" | "completed";
export interface CliCompletion {
  /** Local worker handoff only; true never claims delivery or deletion acknowledgement. */
  reporting: AdvisoryResult<boolean>;
}

/** Optional one-command lifecycle. No implicit observation, dialog, or process hooks. */
export class CliClient {
  readonly reporting: Client;
  readonly updates?: UpdateClient;
  #metric: string;
  #categories: Readonly<Record<string, Dimensions>>;
  #mode: UpdateMode;
  #controller = new AbortController();
  #record?: Promise<AdvisoryResult<InvocationRecorded>>;
  #check?: Promise<AdvisoryResult<Update | undefined>>;
  #completion?: Promise<CliCompletion>;
  #closed = false;

  constructor(options: CliClientOptions) {
    this.reporting = new Client(options);
    const definitions: EventCatalog = catalog.tools;
    const invocation = options.invocation;
    const definition =
      invocation && Object.hasOwn(definitions[options.tool], invocation.metric)
        ? definitions[options.tool][invocation.metric]
        : undefined;
    if (
      !definition ||
      !invocation.categories ||
      typeof invocation.categories !== "object" ||
      Array.isArray(invocation.categories) ||
      Object.keys(invocation.categories).length === 0 ||
      Object.keys(invocation.categories).length > 256
    )
      fail("Configuration");
    const categories: Record<string, Dimensions> = Object.create(null);
    for (const [category, dimensions] of Object.entries(invocation.categories)) {
      if (
        !category ||
        category.length > 64 ||
        !dimensions ||
        typeof dimensions !== "object" ||
        Array.isArray(dimensions) ||
        Object.keys(dimensions).length !== Object.keys(definition.dimensions).length ||
        Object.entries(definition.dimensions).some(
          ([key, values]) => !Object.hasOwn(dimensions, key) || !values.includes(dimensions[key]),
        )
      )
        fail("Configuration");
      categories[category] = Object.freeze({ ...dimensions });
    }
    this.#metric = invocation.metric;
    this.#categories = Object.freeze(categories);
    const policy = resolvePolicy(options.policy);
    if (options.updates && !["enabled", "disabled", "offline"].includes(options.updates.mode))
      fail("Configuration");
    if (
      options.updates?.serviceMetrics !== undefined &&
      typeof options.updates.serviceMetrics !== "boolean"
    )
      fail("Configuration");
    this.#mode = policy.offline ? "offline" : (options.updates?.mode ?? "disabled");
    if (options.updates)
      this.updates = new UpdateClient({
        origin: options.origin,
        tool: options.tool,
        version: options.version,
        cacheRoot: options.updates.cacheRoot,
        distribution: options.updates.distribution,
        channel: options.updates.channel,
        serviceMetrics:
          options.updates.serviceMetrics !== false &&
          !policy.doNotTrack &&
          !policy.hostDisabled &&
          (policy.telemetry === undefined || policy.telemetry === "on"),
      });
  }
  /** Call once where real work starts. Repeated wrapper/watch calls cannot count twice. */
  recordInvocation(category: string): Promise<AdvisoryResult<InvocationRecorded>> {
    if (!Object.hasOwn(this.#categories, category)) fail("Configuration");
    if (this.#closed) return Promise.resolve({ ok: true, value: "completed" });
    if (this.#record) return Promise.resolve({ ok: true, value: "alreadyRecorded" });
    this.#record = this.#advisory(() =>
      this.reporting.record(this.#metric, this.#categories[category]),
    );
    return this.#record;
  }
  /** Host decides output eligibility and when to start. No detached update work. */
  checkForUpdates(
    options: { signal?: AbortSignal } = {},
  ): Promise<AdvisoryResult<Update | undefined>> {
    if (this.#closed) return Promise.resolve({ ok: false, error: new UpdateError("Cancelled") });
    if (this.#check) return this.#check;
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#controller.signal])
      : this.#controller.signal;
    this.#check = this.#advisory(
      () => this.updates?.check(this.#mode, { signal }) ?? Promise.resolve(undefined),
    );
    return this.#check;
  }
  /** Call in finally for success, failure, or interruption. Cancels updates and joins local work. */
  complete(): Promise<CliCompletion> {
    if (this.#completion) return this.#completion;
    this.#closed = true;
    this.#controller.abort();
    this.#completion = (async () => {
      await this.#check;
      await this.#record;
      return { reporting: await this.#advisory(() => this.reporting.flushInBackground()) };
    })();
    return this.#completion;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.complete();
  }
  async #advisory<T>(operation: () => Promise<T>): Promise<AdvisoryResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof TrackingError || e instanceof UpdateError ? e : new TrackingError("State"),
      };
    }
  }
  async status(): Promise<CliStatus> {
    return {
      reporting: await this.reporting.status(),
      history: await this.reporting.historyStatus(),
      publicUsage: await this.reporting.publicUsageStatus(),
      profile: await this.reporting.profileStatus(),
    };
  }
  preview(): ReturnType<Client["preview"]> {
    return this.reporting.preview();
  }
  requestReportingOptIn(reason: string, reminder = false): Promise<PermissionOutcome> {
    if (typeof reminder !== "boolean") fail("Configuration");
    return reminder
      ? this.reporting.requestOptInReminder(reason)
      : this.reporting.requestOptIn(reason);
  }
  /** The host must disclose purpose/data/privacy and obtain an explicit informed choice. */
  async enableReporting(choice: { consent: "informed" }): Promise<CliStatus> {
    if (choice?.consent !== "informed") fail("Configuration");
    await this.reporting.setOptIn(true);
    await this.reporting.setDisabled(false);
    return this.status();
  }
  async withdrawReporting(): Promise<CliStatus> {
    await this.reporting.setOptIn(false);
    await this.#syncWithdrawals();
    return this.status();
  }
  async disableReporting(): Promise<CliStatus> {
    await this.reporting.setDisabled(true);
    await this.#syncWithdrawals();
    return this.status();
  }
  async #syncWithdrawals(): Promise<void> {
    if ((await this.reporting.publicUsageStatus()).pending)
      await this.reporting.syncPublicUsagePermission();
    if ((await this.reporting.historyStatus()).pending)
      await this.reporting.syncHistoryPermission();
    if ((await this.reporting.profileStatus()).pending) await this.reporting.syncProfileLinking();
  }
  /** Persist deletion before handoff. Inspect status later for the server acknowledgement. */
  async deleteReporting(): Promise<{
    deletion: "pending" | "noIdentity";
    handedOff: boolean;
    status: CliStatus;
  }> {
    await this.reporting.delete();
    // Capture before launching: a fast worker must not make a request look unneeded.
    const pending = (await this.reporting.status()).deletionPending;
    const handedOff = await this.reporting.flushInBackground();
    return { deletion: pending ? "pending" : "noIdentity", handedOff, status: await this.status() };
  }
}
