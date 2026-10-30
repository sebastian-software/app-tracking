# app-tracking for Node.js

A TypeScript client for the maintained app-tracking event and download contracts.
The package contains ESM, CommonJS, TypeScript declarations, and its background
worker. It uses Node.js built-ins and bundled JavaScript; consumers need no
Rust toolchain, native addon, platform package, or installation script.

This package shares its version and release tag with the Rust client. It supports
consent reminders ([#53](https://github.com/sebastian-software/app-tracking/issues/53)),
separate history and publication permissions, and optional shared v2 profile
linking. Ferriki adoption and separately registered runtime/host version fields
still need their own delivery evidence. The package supports Node.js 22, 24,
and 26, in both ESM and CommonJS consumers.

## Build and verify

From the repository root, using its pinned pnpm and Node.js versions:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:node-client
```

The command builds both module formats, emits declarations, packs the actual npm
artifact, installs it with npm's `--engine-strict` check, and runs isolated
consumer tests against that artifact. Its HTTP fixtures use loopback servers
and synthetic identities. The command builds a Rust fixture to test shared
profiles across both runtimes. The three-platform
Node-client workflow installs the pinned Rust toolchain for these tests and
checks Node.js 22, 24, and 26 on Linux, macOS, and Windows. It also tests each
major's initial release on Linux. Package builds use the repository's pinned
Node.js 24 toolchain and emit JavaScript compatible with Node.js 22; consumers
do not need the build toolchain.

`pnpm build:node-client` builds only the package. To create a local tarball, run
`npm pack --ignore-scripts` in `packages/node-client` after building. Product
releases are published by the repository Release workflow from the same tag as
the Rust crate; see [the release guide](https://github.com/sebastian-software/app-tracking/blob/main/docs/releasing.md).
The `bootstrap` dist-tag is only a placeholder for initial npm publisher setup
and contains no client implementation.

## Integrate a tool

```ts
import { Client } from "@sebastian-software/app-tracking";
import { homedir } from "node:os";
import { join } from "node:path";

const client = new Client({
  origin: "https://app-tracking.example.com",
  stateRoot: join(homedir(), ".example-tool", "tracking"),
  tool: "ferriki", // Must match the maintained event catalog.
  version: "1.2.3", // The integrating tool/library version.
  interaction: "terminal", // Set never for JSON, editor, and agent modes.
  policy: { offline: false },
});

// Choose an appropriate interactive point and supply the actual privacy link.
await client.requestOptIn(
  "Help prioritize language support. Privacy and settings: https://example.com/privacy",
);

// Observe actual use separately from a resource fetch or a cache hit.
await client
  .record("language.use", {
    language: "rust",
    source: "explicit",
  })
  .catch(() => {});

// Call once at a host-controlled boundary; this waits only for local handoff.
await client.flushInBackground().catch(() => {});
```

Import and construction do not collect system/project information, create state,
or access the network. `requestOptIn` opens a library-owned yes/no dialog.
Alternatively, call `requestOptInReminder(reason)` to offer yes, later, or never.
Later is the default and prompts again only on an eligible call after 14 elapsed
days. Prompt timing is saved before display, including if input is interrupted;
deferral creates no reporting identity or observations. Never and withdrawal
prevent future reminders. Saved grants and refusals are reused. EOF, interruption,
CI, nonterminal input/output, and `interaction: "never"` leave an undecided
choice unchanged. An empty answer declines in the one-time dialog and defers in
the reminder dialog. The host owns its privacy
notice, suitable prompt location, and settings commands.

`setOptIn(true)` is for an explicit informed human settings choice; never infer
it from a committed repository setting. `setOptIn(false)` withdraws consent and
discards unsent data. `setDisabled(true)` stops all reporting and clears unsent
data. `status()` exposes the saved decision and effective restrictions;
`preview()` shows unsent rows/batches without the reporting credential.
`delete()` disables reporting and queues authenticated deletion. Call
`flushInBackground()` afterward; offline mode preserves the pending deletion.
`deletionPending: false` after delivery indicates acknowledgement. Deletion does
not automatically enable another reporting identity.

The constructor combines `DO_NOT_TRACK`, `APP_TRACKING_TELEMETRY`, `CI`,
`CONTINUOUS_INTEGRATION`, and `APP_TRACKING_CI` with explicit host policy.
Environment or host vetoes remain effective over saved consent. CI uses separate
state and requires both `ciRevision: "telemetry-v1"` and
`isolatedCiState: true` in addition to its own explicit usage grant. An ordinary
environment value never grants usage consent. Offline mode permits already
consented local counting and blocks all network operations, including deletion.

## Download a resource

Supply the exact byte length and SHA-256 from a trusted resource manifest:

```ts
await using artifact = await client.download(
  {
    id: "grammar-rust",
    url: "https://cdn.example.com/grammar-rust.bin",
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    reporting: {
      metric: "resource.download",
      dimensions: { kind: "grammar" },
    },
  },
  { signal: cancellation.signal, timeoutMs: 60_000, maxBytes: 128 * 1024 * 1024 },
);
// Copy artifact.path into the host-owned cache before the artifact is disposed.
```

The host supplies `manifest` and an `AbortController` named `cancellation` in this
example. Plain JavaScript can call `await artifact.close()` in `finally` instead
of using `await using`. Closing is idempotent; temporary artifacts require
explicit disposal. Interrupted or failed downloads remove their partial files.

Downloads stream into a private temporary directory with backpressure. Exact
length and SHA-256 must match before a result is returned. Defaults are 128 MiB
and 60 seconds; explicit deadlines are bounded to ten minutes. Redirects,
credentials in URLs, queries, fragments, and compressed responses are rejected.
HTTPS is required except numeric loopback for tests. Cancellation and deadlines
abort the underlying request. No reporting identity, project ID, cookie, or
credential goes to resource hosts. Reporting refusal, lock contention, and
reporting outages do not invalidate an otherwise verified resource.

Cache placement and cache hits belong to the host. Successful downloads may
record `resource.download`; actual language use, including use from an already
populated cache, is a separate `language.use` observation. Call
`flushInBackground()` once at a suitable command boundary rather than for each
highlight.

## State, delivery, and compatibility

Node stores state under
`stateRoot/<service-hash>/<tool>/node-events-v1[/ci]`. Rust continues to use
`events-v1`. These namespaces deliberately do not share decisions, credentials,
locks, or deletion state. A host that exposes both clients must expose their
separate choices and deletion controls. No grant is migrated or inferred from a
neighboring Rust profile.

The host must supply an absolute private local state directory. On Unix,
private directories/files use 0700/0600 and permissive state is rejected. On
Windows, the host must select a private user-profile directory with appropriate
ACLs. State files and final state directories cannot be symlinks. Writes use a
private temporary file, file synchronization, and atomic rename. An incomplete
temporary file is never loaded as committed state. Network shares are outside
the supported persistence contract.

`proper-lockfile` supplies asynchronous interprocess leases with one fixed
30-second stale threshold and five-second renewal. Crashed locks can be
recovered after expiry. A compromised lease fails closed with a sanitized state
error. A client serializes up to 256 pending local operations; concurrent
clients/processes may receive `TrackingError` with `code: "Busy"` and can retry
at their own command boundary. There are no synchronous filesystem writes in
the client. Recording is local and uses the finite registered metric catalog.

The package launches its own worker with a random nonce and bounded local
configuration through stdin. It does not relaunch the consuming CLI, inherit
Node flags/preloads, or pass payloads/credentials in argv. The worker has a
ten-second lifetime and a five-second HTTP deadline. It consumes a fresh
generation-bound job once and rechecks consent before sending. A network lease
prevents a completed withdrawal from racing a later upload. Only the detached
worker briefly retries state-lock contention; foreground calls return `Busy`.

Delivery validates canonical batches with the maintained server validator and
accepts only an exact no-store receipt for the original ID and SHA-256. Lost or
invalid receipts retain immutable bytes and credentials for retry. Failures back
off from one minute to one day; successful fully drained delivery schedules the
next attempt one day later. A worker sends one batch or deletion page. Progress
continues while the consuming tool is used; this is not an always-on daemon.

The SDK bounds rows, daily counts, queued batches, payload size, and local
retention according to the [event contract](https://github.com/sebastian-software/app-tracking/blob/main/docs/event-batches.md).
Changed metric scope requires another explicit permission request. An expired
identity requires deletion before renewing its grant.

System collection happens only after gating and reports bounded categories.
Linux distribution and kernel are separate. The macOS product version is
currently `unknown` because Node exposes Darwin's kernel release. An optional
`projectContext` callback runs once after permission and returns
`{ origin, packageJson }`: `origin: null` means confirmed absent and allows the
package fallback; omitted origin means unavailable and blocks fallback.
Normalization and hashes execute the same golden cases as Rust. Keep metadata
lookup inside the callback. Raw URLs, paths, CPU model strings, and environment
values are never event labels.

## Additional permissions

History and public usage require independent explicit choices. Call
`requestHistoryOptIn(reason)` or `requestPublicUsageOptIn(reason)` only from an
interactive consent command. For notice-only settings, show the exported
`HISTORY_NOTICE` or `PUBLIC_USAGE_NOTICE`, then call `setHistoryOptIn(boolean)`
or `setPublicUsageOptIn(boolean)` after the user's explicit choice. The exported
revision constants identify each disclosure. Publication requires ordinary
reporting and history grants; it does not follow automatically from either.

Use `historyStatus()` and `publicUsageStatus()` to show the saved decision and
whether it is pending. Explicitly call `syncHistoryPermission()` and
`syncPublicUsagePermission()` from settings to send changes; offline or rejected
changes stay pending. Acknowledgement starts eligibility on the following UTC
date and does not mean a monthly summary exists. Withdrawing history also
withdraws publication. Ordinary withdrawal, disabling, and deletion revoke both.

## Optional shared profile linking

Set `sharedProfileRoot` to an absolute private directory also used by Rust's
`with_shared_profile_v2`. Construction does not access it. After ordinary
reporting is enabled, use `requestProfileLinking` or an explicit settings
choice with `setProfileLinking`, and call `syncProfileLinking` to send it.
Use `profileStatus`, `profileResetPending`, `requestProfileReset`, and
`syncProfileReset` for settings. Reset applies only to the shared v2 profile;
legacy Rust v1 links require their own controls. A 404 reset stays pending.
See the [profile guide](../../docs/profile-linking.md) for recovery and scope.

## Independent update checks

`UpdateClient` implements the same version-service contract as Rust. It needs
no reporting client or consent. Import and construction perform no I/O:

```ts
import { UpdateClient } from "@sebastian-software/app-tracking";

const updates = new UpdateClient({
  origin: "https://app-tracking.example.com",
  cacheRoot: "/private/host-owned/update-cache", // Absolute; scoped to this endpoint.
  tool: "ardo",
  version: "1.0.0", // Installed SemVer stays local.
  distribution: "github", // Shared release feed, independent of installation method.
  channel: "stable",
  serviceMetrics: false, // DNT: 1; functional updates remain available.
});
const cancellation = new AbortController();
try {
  const update = await updates.check("enabled", { signal: cancellation.signal });
  if (update) {
    // The host chooses stderr/interactive eligibility and installation guidance.
    console.error(`Update ${update.latestVersion}; see ${update.releaseUrl}`);
  }
} catch {
  // Optional update failures leave the command's stdout and result unchanged.
}
```

`check` accepts `enabled`, `disabled`, or `offline`. The last two perform no
filesystem or network work. `DO_NOT_TRACK` and `serviceMetrics: false` suppress
service statistics, never functional checks. Reporting refusal has no effect on
updates. Results contain `latestVersion`, `releaseUrl`, and `stale`; no remote
shell command is accepted, installed, or executed.

There is one HTTP attempt per due call with the same **200 ms total network
budget** as Rust, including DNS, connection/TLS, headers, and body. Redirects are
rejected. Headers and JSON bodies are each bounded to 16 KiB. Schema, route,
SemVer, HTTPS links, and UTC timestamps are validated. Successful fresh checks
suppress requests for an hour; failures/stale responses use 5, 10, 20, 40, then
60 minutes of backoff. A notice is claimed before return, at most once per
release per 24 hours; higher releases can be offered immediately. Build metadata
does not change SemVer precedence. Original `checked_at` values survive 304s,
opaque strong/weak ETags are preserved, and source results expire after 24 hours.

Cache files live in `cacheRoot/node-updates-v1/<tool>.<distribution>.<channel>.json`.
They contain update metadata and throttles only. Rust's OS-locked update files
are separate: the two runtimes do not share update throttles or notices. Choose
one check owner when a product has multiple entry points. Node uses its existing
nonblocking 30-second interprocess lease with five-second renewal, checks the
lease before committing, and persists a retry claim before opening a connection.
A crashed lease can recover after expiry; the durable claim still backs off.
Corrupt, unknown-schema, or oversized (64 KiB) cache content is ignored and
repaired. Private files use 0600, directories 0700 on Unix; select a private
user-profile root with appropriate ACLs on Windows. Temporary writes are synced
and atomically replaced; incomplete temporary files are never treated as cache.
Network filesystems are outside the persistence contract.

Await each call. The SDK does not detach update work, install exit hooks, or poll
while idle. Cancellation destroys the HTTP request and settles after local
cleanup; no later update request or cache write follows settlement. A pre-request
claim already committed before cancellation remains as backoff. Node may finish
an underlying DNS resolver operation later, but it cannot send that aborted
request. Filesystem and scheduler time are additional to the network budget.
`UpdateError.code` distinguishes `Configuration`, `Cache`, `Network`,
`HttpStatus` (with numeric `status`), `InvalidResponse`, and `Cancelled`; errors
omit private paths, response bodies, and URLs.

## Optional CLI composition

`CliClient` adds a one-command lifecycle above the existing `Client` and
`UpdateClient`. Use one instance per actual command. It does not parse flags,
observe commands automatically, display an automatic dialog, or install process
signal handlers. The packed package includes an executable synthetic example in
`examples/cli.mjs`; its TypeScript declarations need no host-side mirror types.

An Ardo integration can replace its local transport/cache/SemVer module and
reporting/service sequencing with SDK calls:

```ts
import { CliClient } from "@sebastian-software/app-tracking";

const services = new CliClient({
  origin,
  stateRoot,
  tool: "ardo",
  version,
  interaction: eligibleForHumanDialog ? "terminal" : "never",
  policy: hostPolicy, // Host maps its own environment variables here.
  invocation: {
    metric: "cli.invocation",
    categories: {
      dev: { command: "dev" },
      build: { command: "build" },
      preview: { command: "preview" },
    },
  },
  updates: { cacheRoot, distribution: "github", mode: hostUpdateMode },
});

try {
  await services.recordInvocation(commandCategory); // Once, where real work starts.
  await runCommand();
  if (eligibleForUpdateOutput) {
    const result = await services.checkForUpdates({ signal: commandSignal });
    if (result.ok && result.value) renderUpdate(result.value); // Host installation guidance.
  }
} finally {
  await services.complete(); // Also on failure/interruption; async disposal is supported.
}
```

The identifiers in this example are host-supplied values/functions. Ardo's own
flags, environment names, Vite hooks, privacy purpose/link, project discovery,
TTY/JSON/agent eligibility, silent logging, rendering, and installation detection
stay in Ardo. Call `recordInvocation` at the outer observation boundary, never
once in a wrapper and again for every watch iteration. Repeated calls on the
same instance return `alreadyRecorded`; calls after completion return `completed`.
Help, version, and settings paths do not call it. A configured category mapping
is validated against the maintained tool/metric catalog before use.

`recordInvocation`, `checkForUpdates`, and the reporting handoff in `complete`
return `AdvisoryResult<T>`: `{ ok: true, value }` or `{ ok: false, error }`.
Optional operational failures stay observable without rejecting normal command
completion, printing, or changing exit status. Invalid categories remain explicit
configuration errors. Settings operations reject on local failures. Completion
is idempotent: it cancels and joins any started update, joins local recording,
and hands off due reports once without waiting for delivery. No check starts
unless the host calls `checkForUpdates`. If an update should finish before exit,
await its result before calling `complete`; otherwise completion cancels it.
For a host-owned interruption, abort its signal and still await `complete` in
`finally`. The SDK cannot clean up after `SIGKILL` or a direct `process.exit()`.

Settings use the same low-level implementations and policy snapshot:

- `status()` returns ordinary reporting plus separate history, publication, and
  profile decisions/pending state. `preview()` omits credentials.
- `requestReportingOptIn(reason, reminder?)` explicitly invokes the maintained
  disclosure/dialog and saved-choice logic. It is never called automatically.
- `enableReporting({ consent: "informed" })` persists an explicit informed human
  settings choice and removes a saved disable. The host must first disclose the
  purpose/data/privacy link and obtain that choice; never derive it from config,
  CI flags, output eligibility, or an upgrade. Environment vetoes still win.
- `withdrawReporting()` discards unsent data and withdraws additional permissions.
  `disableReporting()` stops collection and discards unsent data. Both synchronize
  existing additional withdrawals when possible and return pending status; they
  never grant history, publication, or profile linking.
- `deleteReporting()` persists authenticated deletion before local worker handoff.
  Its `deletion: "pending"` is a request, not confirmation; `handedOff: true` is
  only local scheduling. `noIdentity` means there is no identity left to delete.
  Inspect `status().reporting.deletionPending` on a later settings call: only its
  transition from true to false after delivery demonstrates acknowledgement.
  Offline requests remain pending, and settings stay disabled afterward.

Offline policy overrides an enabled update mode and blocks all network work.
Reporting refusal/disable does not disable updates. CI retains its separate
state, revision/isolation prerequisites, and explicit grant. The low-level
`reporting` and `updates` clients remain available for advanced integrations.
Actual Ardo adoption and deletion of its temporary implementation remain in
[Ardo PR #440](https://github.com/sebastian-software/ardo/pull/440).
