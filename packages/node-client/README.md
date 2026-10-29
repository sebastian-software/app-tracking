# app-tracking for Node.js

A TypeScript client for the maintained app-tracking event and download contracts.
The package contains ESM, CommonJS, TypeScript declarations, and its background
worker. It uses Node.js built-ins and bundled JavaScript; consumers need no
Rust toolchain, native addon, platform package, or installation script.

This package is currently private and unpublished. It implements the shared
Node-client portion of [issue #53](https://github.com/sebastian-software/app-tracking/issues/53).
Ferriki adoption, npm release automation, and separately registered runtime/host
version fields still need their own delivery evidence. The Rust SDK's additional
history, public-usage, and cross-tool profile permissions are not enabled by this
client. This package currently targets the repository's Node.js 24 runtime.

## Build and verify

From the repository root, using its pinned pnpm and Node.js versions:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:node-client
```

The command builds both module formats, emits declarations, packs the actual npm
artifact, and runs isolated consumer tests against that artifact. Its HTTP
fixtures use loopback servers and synthetic identities. The three-platform
Node-client workflow runs the same command without installing Rust.

`pnpm build:node-client` builds only the package. To create a local tarball, run
`npm pack --ignore-scripts` in `packages/node-client` after building. Do not
publish a tarball until the remaining release and consumer acceptance is ready.

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
or access the network. Only `requestOptIn` may open the library-owned yes/no
dialog. Saved grants and refusals are reused. EOF, interruption, invalid input,
CI, nonterminal input/output, and `interaction: "never"` leave an undecided
choice unchanged. An empty submitted answer declines. The host owns its privacy
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
