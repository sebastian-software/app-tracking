# The same task in Rust and Node.js

Use this guide to integrate either client and to review feature parity. Every
task has a Rust example followed by its Node.js equivalent. Start with the
[README capability table](../README.md#rust-and-nodejs-side-by-side); keep both
halves current when extending a client. API and runtime differences are listed
below; the [parity notes](client-parity.md) record the common baseline and
exceptions to shared contracts.

These examples describe the current repository APIs. Select matching Rust/npm
product releases that contain them; a main-branch example does not establish
that a release has been published. See [releasing](releasing.md).

Rust snippets run inside a host function returning
`Result<(), Box<dyn std::error::Error>>`; Node snippets use TypeScript in an async
function or ESM module. Except for the independent update example, later snippets
reuse the reporting `client` below. They are separate host-controlled actions,
not a startup script to execute in sequence. All origins and paths are synthetic;
the host supplies its endpoint and private absolute paths for the current OS.

## Configure a passive reporting client

Both examples select the same registered tool/version and ordinary reporting
contract. They start offline and prohibit dialogs. A real host resolves its
offline, DNT, analytics-disable, CI/isolation, and output policy before use.
Neither construction grants consent or creates state, identities, or observations.

**Rust**

```rust
use app_tracking::client::{Client, Interaction, BACKGROUND_WORKER_ARGUMENT};
use app_tracking::telemetry::Policy;

let client = Client::registered(
    "https://tracking.example.com", "/private/example-tool/reporting", "ardo", "1.0.0",
)?
.with_policy(Policy { offline: true, ..Policy::default() })
.with_interaction(Interaction::Never);

// Before normal argument parsing; a reporting worker is not a user invocation.
let args: Vec<_> = std::env::args().collect();
if args.get(1).map(String::as_str) == Some(BACKGROUND_WORKER_ARGUMENT) {
    client.run_background_worker(args.get(2).ok_or("missing worker nonce")?)?;
    return Ok(());
}
```

**Node.js**

```ts
import { Client, type ClientOptions } from "@sebastian-software/app-tracking";

const clientOptions: ClientOptions = {
  origin: "https://tracking.example.com",
  stateRoot: "/private/example-tool/reporting",
  tool: "ardo",
  version: "1.0.0",
  policy: { offline: true },
  interaction: "never",
};
let client = new Client(clientOptions);
// The package supplies its worker; no reserved CLI argument is needed.
```

Rust receives a host-resolved `Policy`; it does not read policy environment
variables implicitly. Node also combines host options with its documented
`DO_NOT_TRACK`, `APP_TRACKING_TELEMETRY`, and CI environment vetoes. Neither
runtime treats configuration or CI detection as ordinary reporting consent.
CI has separate state and needs an explicit grant, the current revision, and an
isolated CI root. See [Rust policy](unified-client.md#explicit-ci-authorization)
and [Node policy](../packages/node-client/README.md#integrate-a-tool).

## Check for updates

This task needs no reporting client, identity, consent, or repository context.
Both examples opt out of service statistics while keeping functional checks.
The host decides whether a check and a notice fit the current command/output.

**Rust**

```rust
use app_tracking::{Mode, Tool, UpdateClient};

let updates = UpdateClient::new(
    "https://updates.example.com", "/private/example-tool/updates",
    Tool::new("ardo", "1.0.0", "github", "stable")?,
)?.with_service_metrics(false);
if let Ok(Some(update)) = updates.check(Mode::Enabled) {
    eprintln!("Update {}; see {}", update.latest_version, update.release_url);
}
```

**Node.js**

```ts
import { UpdateClient } from "@sebastian-software/app-tracking";

const updates = new UpdateClient({
  origin: "https://updates.example.com",
  cacheRoot: "/private/example-tool/updates",
  tool: "ardo",
  version: "1.0.0",
  distribution: "github",
  serviceMetrics: false,
});
const cancellation = new AbortController();
try {
  const update = await updates.check("enabled", { signal: cancellation.signal });
  if (update) console.error(`Update ${update.latestVersion}; see ${update.releaseUrl}`);
} catch {
  // An advisory failure must preserve the command's stdout and exit status.
}
```

Use `Mode::Disabled`/`Mode::Offline` or `"disabled"`/`"offline"` for no network
or filesystem access. Both clients keep a 200 ms total network budget, compare
SemVer locally, back off after failure/stale results, and throttle notices.
Rust completes synchronously. Node must be awaited, or cancelled and then
awaited before exit. Do not install or execute anything from update metadata;
installation-specific guidance belongs to the host.

## Supply optional repository context lazily

Only supply this if it is part of the tool's disclosure. Keep actual metadata
discovery inside the callback. The SDK calls it after effective collection
permission and applies the shared normalization/hash contract. Construction
alone does not execute either callback.

**Rust**

```rust
use app_tracking::project::{Origin, RepositoryContext};

let client = client.with_project_context(|| RepositoryContext {
    origin: Origin::Present("https://github.com/example-org/example-project".into()),
    package_json: None,
});
```

**Node.js**

```ts
clientOptions.projectContext = () => ({ origin: "https://github.com/example-org/example-project" });
client = new Client(clientOptions);
```

An unavailable origin is Rust `Origin::Unavailable` or an omitted Node `origin`;
a confirmed absence is `Origin::Absent` or `origin: null`. Only confirmed absence
permits a package.json fallback. See [project identity](project-identity.md).

## Ask for reporting permission

Call only at a host-selected consent point. For a human terminal dialog, change
the configured interaction to `Interaction::Terminal` or `"terminal"` only when
the host permits it. The noninteractive setup above reuses saved choices and
otherwise returns unavailable. JSON, editor, agent, and CI modes must not prompt.

**Rust**

```rust
let permission = client.request_opt_in_reminder(
    "Help prioritize tool maintenance. Privacy and settings: https://example.com/privacy",
)?;
```

**Node.js**

```ts
const permission = await client.requestOptInReminder(
  "Help prioritize tool maintenance. Privacy and settings: https://example.com/privacy",
);
```

Both offer allow, later (default; ask on an eligible invocation after 14 days),
or never. Later grants nothing; never and withdrawal suppress future reminders.
The one-time yes/no alternatives are `request_opt_in` and `requestOptIn`.
Neither ordinary recording nor downloading opens a dialog automatically.

## Record an actual invocation

Place this once where real work starts. Do not count help, version, settings,
wrapper dispatch, and each watch iteration as additional command invocations.
The SDK applies saved consent and current vetoes before collecting context.

**Rust**

```rust
let _ = client.record("cli.invocation", || {
    [("command".into(), "build".into())].into()
});
let _ = client.flush_in_background();
```

**Node.js**

```ts
await client.record("cli.invocation", { command: "build" }).catch(() => {});
await client.flushInBackground().catch(() => {});
```

Both record locally and hand off at most one due operation without waiting for
reporting delivery. Optional reporting failures must preserve normal command
output and exit status. Rust needs the worker entry shown in setup; Node owns
its executable worker. Offline mode can count locally after consent but cannot
send. These are the low-level calls; the Node convenience layer below also
deduplicates its host-owned invocation boundary.

## Inspect and change settings

Settings failures stay observable. Unlike optional normal-command work, do not
silently catch an explicit failed control action or claim success on `Busy`.

**Rust**

```rust
let status = client.status()?;
let preview = client.preview()?;
// In the corresponding explicit settings actions, not during startup:
client.set_opt_in(false)?; // Withdraw and discard unsent usage.
client.set_disabled(true)?; // Stop collection and discard unsent usage.
client.delete()?;
let handed_off = client.flush_in_background()?;
```

**Node.js**

```ts
const status = await client.status();
const preview = await client.preview();
// In the corresponding explicit settings actions, not during startup:
await client.setOptIn(false); // Withdraw and discard unsent usage.
await client.setDisabled(true); // Stop collection and discard unsent usage.
await client.delete();
const handedOff = await client.flushInBackground();
```

Both previews omit reporting credentials. Rust returns JSON text; Node returns
an object. An explicit informed enable action uses `set_opt_in(true)`/
`setOptIn(true)` and, if needed, removes a saved disable with `set_disabled(false)`/
`setDisabled(false)`. Never derive this choice from repository config or CI flags.

`handed_off`/`handedOff` means local scheduling only. Inspect
`status.deletion_pending`/`status.deletionPending` on later settings calls:
pending becomes false after authenticated acknowledgement. Offline deletion
stays pending. Withdrawal is not deletion; history/publication/profile withdrawals
need their explicit synchronization or completed authenticated deletion.

## Download and dispose of a verified resource

Both clients verify exact byte length and SHA-256 before returning a temporary
artifact. Supply real descriptor values from a trusted manifest. This example
uses a zero-byte synthetic resource and its actual digest; the URL is a placeholder.
Both clients accept IDs of 1–128 ASCII characters, starting with a lowercase
letter or digit and continuing with lowercase letters, digits, `.`, `_`, or `-`.

**Rust**

```rust
use app_tracking::client::{DownloadOptions, Resource};

let resource = Resource::new(
    "2d-grammar", "https://cdn.example.com/example-data.bin", 0,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
)?;
let artifact = client.download(&resource, &DownloadOptions::default())?;
// Copy artifact.path() into the host-owned cache before disposal.
drop(artifact);
```

**Node.js**

```ts
const artifact = await client.download({
  id: "2d-grammar",
  url: "https://cdn.example.com/example-data.bin",
  bytes: 0,
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
});
try {
  // Copy artifact.path into the host-owned cache before disposal.
} finally {
  await artifact.close();
}
```

With the offline setup these calls return `Offline`; the host uses its existing
cache instead. Downloads remain independent of reporting consent. Rust uses a
cooperative `Cancellation` token and bounded reads; Node accepts an `AbortSignal`
in download options. Node also supports async disposal. See the language guides
for deadlines and optional registered resource-download observations.

## Download a pinned resource through a signed link

On a cache miss, pass the issuer URL, exact CDN origin, asset path and checksum
from trusted configuration. Pass the build token from the build's secret
store. The SDK sends the token only to the issuer, validates the returned
Bunny query and exact asset path, and verifies the CDN response within the
same total deadline. The build token grants download access. Reporting uses
the client's existing permission and only happens after verification. Cached
and offline builds are handled by the host.

**Rust**

```rust
use app_tracking::client::{DownloadOptions, SignedResource};

let theme = SignedResource::new(
    "theme.nord",
    "https://downloads.ferriki.dev/v1/downloads",
    "https://protected-assets.ferriki.dev",
    "/themes/nord/DVzhgQds",
    Some(26_684),
    "e68ff2dae71a50102ba8c9d37f1938c88a877b71b42e7aefd20b3f2cf801d784",
)?;
let artifact = client.download_signed(&theme, &build_token, &DownloadOptions::default())?;
// Copy artifact.path() into the host-owned cache before disposal.
```

**Node.js**

```ts
await using artifact = await client.downloadSigned(
  {
    id: "theme.nord",
    issuerUrl: "https://downloads.ferriki.dev/v1/downloads",
    cdnOrigin: "https://protected-assets.ferriki.dev",
    path: "/themes/nord/DVzhgQds",
    bytes: 26_684,
    sha256: "e68ff2dae71a50102ba8c9d37f1938c88a877b71b42e7aefd20b3f2cf801d784",
  },
  buildToken,
);
// Copy artifact.path into the host-owned cache before disposal.
```

For a manifest pinned by its checksum alone, omit the expected size in Node or
pass `None` in Rust. The issuer's size must then fit the configured byte limit
and match the actual download. The response cannot change the pinned digest.

For a download-only integration, call the exported `app_tracking::client::download_signed`
or `downloadSigned` function with the same inputs. The standalone function needs no
reporting client, does not report events, and leaves the offline decision to the host.

## Request separate history and publication permissions

Ordinary reporting consent grants neither permission. Each dialog is an explicit
host action; history requires ordinary reporting and publication additionally
requires history. The requests below are separate interactive settings choices.

**Rust**

```rust
let history = client.request_history_opt_in("Help understand long-term usage trends.")?;
let history_synced = client.sync_history_permission()?;
let publication = client.request_public_usage_opt_in("Help publish screened adoption totals.")?;
let publication_synced = client.sync_public_usage_permission()?;
let history_status = client.history_status()?;
let publication_status = client.public_usage_status()?;
```

**Node.js**

```ts
const history = await client.requestHistoryOptIn("Help understand long-term usage trends.");
const historySynced = await client.syncHistoryPermission();
const publication = await client.requestPublicUsageOptIn("Help publish screened adoption totals.");
const publicationSynced = await client.syncPublicUsagePermission();
const historyStatus = await client.historyStatus();
const publicationStatus = await client.publicUsageStatus();
```

Both retain pending changes offline or without an exact acknowledgement.
Acknowledgement starts eligibility on the following UTC date; it does not mean
a monthly summary or public export exists. For notice-only host settings, use
each runtime's exported disclosure and the corresponding explicit setter. See
[history](monthly-history.md) and [publication](public-usage-consent.md).

## Link and reset a shared v2 profile

Configure the same private shared root in participating Rust and Node hosts.
Configuration is passive; linking requires its own explicit choice after
ordinary reporting. CI cannot link. Reset and ordinary report deletion are
different operations and should be separate settings commands.

**Rust**

```rust
let client = client.with_shared_profile_v2("/private/example-tool/shared");
let linking = client.request_profile_linking_v2("Help understand which tools are used together.")?;
let linked = client.sync_profile_linking_v2()?;
let profile = client.profile_status_v2()?;
// In a separate explicit reset action:
client.request_profile_reset_v2()?;
let reset_confirmed = client.sync_profile_reset_v2()?;
```

**Node.js**

```ts
client = new Client({ ...clientOptions, sharedProfileRoot: "/private/example-tool/shared" });
const linking = await client.requestProfileLinking(
  "Help understand which tools are used together.",
);
const linked = await client.syncProfileLinking();
const profile = await client.profileStatus();
// In a separate explicit reset action:
await client.requestProfileReset();
const resetConfirmed = await client.syncProfileReset();
```

Only the shared v2 profile format interoperates. Ordinary reporting decisions,
credentials, queues, and update caches remain separate between runtimes. Rust
also retains legacy v1 profile methods; Node does not read or migrate that state.
Both require an exact reset acknowledgement before rotating the v2 profile ID;
offline and missing-profile responses remain pending. See [profiles](profile-linking.md).

## Compose the command lifecycle

The same host responsibilities apply in either language: choose an actual
observation boundary, preserve command output/result, avoid implicit consent,
and clean up optional work when the command finishes or is interrupted.

**Rust**

Use `cli::CliClient` for one command. Dispatch the reserved worker before
parsing host flags with `cli::handle_worker` and a factory for the same
configured reporting client. The synchronous `UpdateClient` still checks
independently.

```rust
use app_tracking::cli::CliClient;

let mut services = CliClient::new(reporting);
let _ = services.record_invocation(
    "cli.invocation",
    [("command".into(), "build".into())].into(),
);
// Run the host command here and check for updates when its output policy allows.
let _ = services.complete();
```

The complete [Rust example](../crates/app-tracking/examples/cli-integration.rs)
includes settings and preserves a deliberately nonzero command exit code.

**Node.js**

The optional `CliClient` packages promise ownership, one-command deduplication,
settings sequencing, and cancellation. It wraps the same low-level clients:

```ts
import { CliClient } from "@sebastian-software/app-tracking";

const services = new CliClient({
  ...clientOptions,
  invocation: { metric: "cli.invocation", categories: { build: { command: "build" } } },
  updates: { cacheRoot: "/private/example-tool/updates", distribution: "github", mode: "enabled" },
});
try {
  await services.recordInvocation("build");
  // Run the host command here; only render updates if its output policy allows.
  const result = await services.checkForUpdates();
  if (result.ok && result.value) console.error(`Update ${result.value.latestVersion}`);
} finally {
  await services.complete();
}
```

The offline host policy still vetoes checks. No check or observation runs on
construction. Completion joins local work and cancels any unfinished update;
it does not wait for report delivery. If an update should finish, await it before
completion. The JavaScript worker is package-owned, so the host has no worker
arguments to handle.
The [Node guide](../packages/node-client/README.md#optional-cli-composition) and
[packed example](../packages/node-client/examples/cli.mjs) show the full surface.

### Reporting settings and project context

| Task                                                       | Rust                                                          | Node.js                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Inspect state and redacted data                            | `status`, `preview`                                           | `status`, `preview`                                            |
| Reconsider a saved refusal from explicit settings          | `request_reporting_opt_in_in_settings(reason)`                | `requestReportingOptInInSettings(reason)`                      |
| Apply an informed operator choice on CI                    | `enable_ci_reporting()`                                       | `enableCiReporting({ consent: "informed" })`                   |
| Withdraw, disable, or request deletion                     | `withdraw_reporting`, `disable_reporting`, `delete_reporting` | `withdrawReporting`, `disableReporting`, `deleteReporting`     |
| Resolve the standard reporting root                        | `cli::default_state_root(tool)`                               | `defaultReportingStateRoot(tool)`                              |
| Check an isolated job directory                            | `cli::validate_ci_state_root(root, personal)`                 | `validateCiStateRoot(root, personal)`                          |
| Apply environment vetoes                                   | `cli::policy_from_environment(policy)`                        | `policyFromEnvironment(policy)` (automatic in the Node client) |
| Read one raw Git origin                                    | `project::git_origin(directory)`                              | `gitOrigin(directory)`                                         |
| Append the hosted service disclosure to the tool's purpose | `cli::hosted_reporting_notice()`                              | `HOSTED_REPORTING_NOTICE`                                      |

Keep an existing reporting root to preserve decisions and credentials.
Supply the personal root to the CI validator when available and pass the
validated directory into the client before marking it isolated. On Windows,
the operator must give the job directory a private ACL. Ask for informed
authorization in a dedicated CI settings action. The consent revision
environment variable identifies the disclosure and does not express consent.

Call the Git helper within the lazy project context callback, with the directory
that the command actually operates on. Missing, ambiguous, or unsafe lookup
results produce no project identity unless the SDK can use a confirmed absence
for an independently supplied package fallback.

## Differences to keep visible

| Boundary                   | Rust                                                                                      | Node.js                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Execution and cleanup      | Synchronous `Result`; RAII disposes downloads                                             | Promises and `AbortSignal`; explicitly close or async-dispose downloads           |
| Reporting worker           | Host dispatches the reserved argument with `cli::handle_worker`                           | Package-owned worker                                                              |
| Metric definitions         | Shipped catalog via `Client::registered`; additional low-level `Client::new`/`Metric` API | Shipped catalog only; no custom-definition API                                    |
| Policy resolution          | Host policy with optional environment veto helper                                         | Host options plus documented environment vetoes                                   |
| Reporting and update state | Rust namespaces and OS locks                                                              | Separate Node namespaces and JavaScript leases                                    |
| Shared profile             | v2 interoperates; legacy v1 remains Rust-only                                             | v2 only; no legacy grant migration                                                |
| System context             | Native collectors                                                                         | macOS product version currently `unknown`; Node exposes the Darwin kernel version |
| Convenience layer          | Optional synchronous `cli::CliClient`                                                     | Optional `CliClient`                                                              |

The common integration uses the centrally maintained event catalog in both
languages. Rust's additional metric-definition API does not register a tool or
metric on the server; custom definitions still need a matching receiver. The
legacy Rust invocation client is also outside these generic event examples.

New shared behavior still needs both implementations and equivalent validation.
Review this guide alongside the [parity notes](client-parity.md) and the shared
fixtures in [`contracts/`](../contracts/) before extending either client.
