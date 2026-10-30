import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { canonical, record } from "../../../src/telemetry/contract.ts";
import { eventBatch, type EventBatch } from "../../../src/telemetry/events.ts";
import { hash } from "./context.ts";
import { fail, TrackingError } from "./types.ts";

export const random = () => randomBytes(32).toString("hex");
export const DAY = 86_400_000;
export const MAX_STATE = 4 * 1024 * 1024;
export const hex = /^[a-f0-9]{64}$/;
export function now(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0 || value >= 253_402_300_800_000) fail("Clock");
  return value;
}
export interface Identity {
  id: string;
  token: string;
  consentedAt: number;
  lastAcceptedAt: number;
}
export interface Pending {
  id: string;
  body: string;
  sha256: string;
  day: number;
}
export interface Job {
  nonce: string;
  generation: number;
  created: number;
  batch: string;
}
export interface AdditionalChoice {
  revision: string;
  enabled: boolean;
  changedAt: number;
  confirmed: boolean;
}
export interface State {
  history?: AdditionalChoice;
  publicUsage?: AdditionalChoice;
  schemaVersion: 1;
  scope: string;
  optIn: boolean | null;
  optInScope: string | null;
  lastPermissionPromptAt?: number;
  identity: Identity | null;
  disabled: boolean;
  deleting: boolean;
  generation: number;
  open: Record<string, Record<string, unknown>>;
  batches: Pending[];
  job: Job | null;
  failures: number;
  nextAttempt: number;
  dropped: number;
}
export function empty(scope: string): State {
  return {
    schemaVersion: 1,
    scope,
    optIn: null,
    optInScope: null,
    identity: null,
    disabled: false,
    deleting: false,
    generation: 0,
    open: {},
    batches: [],
    job: null,
    failures: 0,
    nextAttempt: 0,
    dropped: 0,
  };
}
function privateMode(mode: number) {
  if (process.platform !== "win32" && (mode & 0o077) !== 0) fail("State");
}
export async function directory(path: string, create: boolean): Promise<boolean> {
  try {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const meta = await lstat(path);
    if (meta.isSymbolicLink() || !meta.isDirectory()) fail("State");
    privateMode(meta.mode);
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof TrackingError) throw error;
    fail("State");
  }
}

export type Lease = (() => Promise<void>) & { check(): void };
export async function lock(path: string): Promise<Lease> {
  let compromised = false;
  try {
    // One fixed lease policy for all Node readers/writers. A crashed writer's
    // lock expires; active asynchronous operations renew the lease. Local
    // private filesystems are supported; network shares are not a state store.
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 5000,
      retries: 0,
      onCompromised: () => {
        compromised = true;
      },
    });
    return Object.assign(
      async () => {
        if (compromised) fail("State");
        try {
          await release();
        } catch {
          fail("State");
        }
      },
      {
        check: () => {
          if (compromised) fail("State");
        },
      },
    );
  } catch (error) {
    fail((error as NodeJS.ErrnoException).code === "ELOCKED" ? "Busy" : "State");
  }
}

export async function load(
  path: string,
  scope: string,
  tool: string,
  metricScope: string,
): Promise<State> {
  let file;
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > MAX_STATE) fail("State");
    privateMode(meta.mode);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = await file.stat();
    if (meta.ino !== actual.ino || meta.dev !== actual.dev || actual.size > MAX_STATE)
      fail("State");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (
      !record(value) ||
      value.schemaVersion !== 1 ||
      value.scope !== scope ||
      ![null, true, false].includes(value.optIn as null | boolean) ||
      typeof value.disabled !== "boolean" ||
      typeof value.deleting !== "boolean" ||
      !(value.optInScope === null || typeof value.optInScope === "string") ||
      !record(value.open) ||
      !Array.isArray(value.batches) ||
      Object.keys(value.open).length > 4096 ||
      value.batches.length > 64
    )
      fail("State");
    if (
      ["generation", "failures", "nextAttempt", "dropped"].some(
        (key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0,
      )
    )
      fail("State");
    for (const key of ["history", "publicUsage"]) {
      const choice = value[key];
      if (
        choice !== undefined &&
        (!record(choice) ||
          Object.keys(choice).sort().join() !== "changedAt,confirmed,enabled,revision" ||
          typeof choice.revision !== "string" ||
          typeof choice.enabled !== "boolean" ||
          typeof choice.confirmed !== "boolean" ||
          !Number.isSafeInteger(choice.changedAt) ||
          Number(choice.changedAt) < 0 ||
          Number(choice.changedAt) > 253_402_300_799_999 ||
          (key === "publicUsage" && Buffer.byteLength(choice.revision) > 64) ||
          (choice.enabled &&
            (value.identity === null ||
              value.optIn !== true ||
              value.disabled === true ||
              value.deleting === true ||
              (key === "publicUsage" &&
                (!record(value.history) || value.history.enabled !== true)))))
      )
        fail("State");
    }
    if (
      value.lastPermissionPromptAt !== undefined &&
      (!Number.isSafeInteger(value.lastPermissionPromptAt) ||
        Number(value.lastPermissionPromptAt) < 0 ||
        Number(value.lastPermissionPromptAt) >= 253_402_300_800_000)
    )
      fail("State");
    if (value.identity !== null) {
      if (
        !record(value.identity) ||
        !hex.test(String(value.identity.id)) ||
        !hex.test(String(value.identity.token)) ||
        ![value.identity.consentedAt, value.identity.lastAcceptedAt].every(
          (n) => Number.isSafeInteger(n) && Number(n) >= 0,
        )
      )
        fail("State");
    } else if (value.optIn === true || value.deleting) fail("State");
    if (
      value.job !== null &&
      (!record(value.job) ||
        !hex.test(String(value.job.nonce)) ||
        !Number.isSafeInteger(value.job.generation) ||
        !Number.isSafeInteger(value.job.created) ||
        typeof value.job.batch !== "string")
    )
      fail("State");
    const state = value as unknown as State;
    // A new catalog must discard old optional payloads before validating them
    // against its changed vocabulary. The saved scope still requires a fresh
    // human grant; an old row cannot make permission/settings unusable.
    if (state.optInScope !== metricScope && !state.deleting) clear(state);
    const batch = (rows: Record<string, unknown>[]): EventBatch => ({
      schema_version: 1,
      tool_id: tool,
      batch_id: "0".repeat(64),
      collection: "opt_in",
      mode: "local",
      installation_id: state.identity?.id ?? "0".repeat(64),
      consented_at: state.identity?.consentedAt ?? 0,
      rows,
    });
    for (const [key, row] of Object.entries(state.open)) {
      eventBatch(batch([row]));
      const { count: _count, ...dimensions } = row;
      if (key !== hash(canonical(dimensions))) fail("State");
    }
    for (const pending of state.batches) {
      if (
        !record(pending) ||
        !hex.test(pending.id) ||
        typeof pending.body !== "string" ||
        Buffer.byteLength(pending.body) > 60_000 ||
        hash(pending.body) !== pending.sha256 ||
        !Number.isSafeInteger(pending.day)
      )
        fail("State");
      const parsed = eventBatch(JSON.parse(pending.body));
      if (
        canonical(parsed) !== pending.body ||
        parsed.tool_id !== tool ||
        parsed.batch_id !== pending.id ||
        parsed.installation_id !== state.identity?.id ||
        parsed.consented_at !== state.identity?.consentedAt
      )
        fail("State");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(scope);
    return fail("State");
  } finally {
    await file?.close();
  }
}

export async function save(path: string, state: State): Promise<void> {
  const body = JSON.stringify(state);
  if (Buffer.byteLength(body) > MAX_STATE) fail("State");
  const temporary = `${path}.${random()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(body);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } catch {
    fail("State");
  } finally {
    await file?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function prune(state: State, timestamp: number): void {
  const day = Math.floor(timestamp / DAY);
  for (const [key, row] of Object.entries(state.open))
    if (Number(row.day) < day - 6 || Number(row.day) > day) delete state.open[key];
  state.batches = state.batches.filter((batch) => batch.day >= day - 6 && batch.day <= day);
}
export function clear(state: State) {
  state.open = {};
  state.batches = [];
  state.job = null;
}
export function closeBatch(state: State, tool: string, ci: boolean): void {
  if (!state.identity || !Object.keys(state.open).length || state.batches.length >= 64) return;
  const id = random();
  const rows: Record<string, unknown>[] = [];
  const keys: string[] = [];
  let total = 0;
  const encode = () =>
    canonical(
      eventBatch({
        schema_version: 1,
        tool_id: tool,
        batch_id: id,
        collection: "opt_in",
        mode: ci ? "ci" : "local",
        installation_id: state.identity!.id,
        consented_at: state.identity!.consentedAt,
        rows,
      }),
    );
  for (const [key, row] of Object.entries(state.open)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 64)) {
    if (total + Number(row.count) > 10_000_000) break;
    rows.push(row);
    if (Buffer.byteLength(encode()) > 60_000) {
      rows.pop();
      break;
    }
    keys.push(key);
    total += Number(row.count);
  }
  if (!rows.length) fail("State");
  const body = encode();
  state.batches.push({
    id,
    body,
    sha256: hash(body),
    day: Math.min(...rows.map((r) => Number(r.day))),
  });
  for (const key of keys) delete state.open[key];
}

export const statePath = (directory: string) => join(directory, "state.json");
