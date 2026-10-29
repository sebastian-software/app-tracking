# Unified Rust client

`app_tracking::client::Client` owns the opt-in dialog, saved collection settings, finite counter
dimensions, shared system context, verified resource downloads, and background
reporting. The legacy update and invocation clients remain compatible.

## Integration

Create one client per reporting tool/service/profile. Construction performs no
I/O. `Client::registered` loads the shipped product definitions; `Client::new`
accepts host-authored `Metric` definitions using the same counter primitives.
The receiver must already have matching definitions. Unknown tools, metric
IDs, values, or mismatched collection routes are rejected by the service.

```rust
use app_tracking::client::{Client, BACKGROUND_WORKER_ARGUMENT};
use std::collections::BTreeMap;

let client = Client::registered(origin, private_state_root, "palamedes", "2.0.0")?;

// Handle before ordinary argument parsing. Never count the worker as usage.
let args: Vec<_> = std::env::args().collect();
if args.get(1).map(String::as_str) == Some(BACKGROUND_WORKER_ARGUMENT) {
    client.run_background_worker(args.get(2).ok_or("missing worker token")?)?;
    return Ok(());
}

// Explicitly request permission at a suitable interactive point:
let permission = client.request_opt_in_reminder("Help prioritize Palamedes commands and platform support.")?;

// At the designated observation boundary:
let _ = client.record("cli.invocation", || BTreeMap::from([
    ("command".into(), "catalogcompile".into()),
]));
let _ = client.flush_in_background();
```

The [`unified-client-fixture`](../crates/app-tracking/examples/unified-client-fixture.rs)
is an executable consumer used by the PostgreSQL integration suite. It has
only explicit synthetic endpoint/state configuration and no production default.

## Permission request and settings

`request_opt_in(message)` owns the complete permission flow. The host supplies
its product-specific reason; the SDK adds a summary of the registered opt-in
metrics, categorical fields, reporting identity, and selected system/project
context. It writes to stderr, offers yes/no, and saves the answer in its private
state. A submitted empty answer means no. Saved yes and no answers are reused
on later calls without asking again. The reason is displayed, not persisted.
Include a public privacy/settings link in the reason when appropriate.

The result is `PermissionOutcome::Granted`, `Declined`, or `Unavailable`.
`Unavailable` covers an ineligible context or a dialog without a submitted
answer; it does not create a refusal. `status().decision` separately exposes
`Undecided`, `Granted`, or `Declined`. No state is created before an answer.
The SDK releases locks while the person answers. Refusal wins when concurrent
dialogs complete in either order; an affirmative answer cannot overwrite a
concurrent settings change.

New dialogs require terminal stdin and stderr, never run in CI or a background
worker, and respect process-level disabling. Configure
`with_interaction(Interaction::Never)` for JSON output, editor integrations,
and other unattended host modes. That option still reuses eligible saved
answers. Construction, `record`, and `download` never prompt automatically.
A declined request is not repeated; explicit settings changes use
`set_opt_in(bool)`. An internal fingerprint ties grants to the opt-in metric
definitions and context. A changed scope stops opt-in collection and requires
a fresh explicit permission request and discards unsent opt-in observations;
it does not silently expand a saved grant.
This local check does not introduce another wire protocol version.

### Optional 14-day reminders

Use `request_opt_in_reminder(message)` at the same suitable interactive boundary
to offer a deferred choice again. The SDK opens with "Is the tool working well
for you?" and explains how optional statistics help prioritize improvements.
This is an invitation, not a satisfaction survey; no satisfaction answer is
collected or converted into consent. The usual metric/system/project disclosure
remains visible before the reporting choice.

The choices are `yes` (explicit grant), `later` (default; grants no new permission),
and `never` (saved refusal). `no` also means never. Grants, existing refusals,
and withdrawals are not asked again. Global disable, pending deletion, CI,
workers, nonterminal stdin/stderr, and `Interaction::Never` prevent a new dialog.
The interval is 14 elapsed days per tool/service/profile from the last claimed
prompt. A later host call can display a due reminder; no timer wakes the tool.
Clock rollback defers the reminder until the interval has genuinely passed.

The helper saves only prompt timing in private local settings before displaying
the question. This also throttles EOF, terminal errors, crashes, and concurrent
invocations. It creates no reporting ID, project hash, usage row, queue, or
network request. Locks are released before input; a concurrent refusal still
wins over an affirmative answer. `Unavailable` includes cooldown and deferral.
The original `request_opt_in` remains the one-time yes/no API, with no timing
state before an answer. Old settings load without the optional timing field;
older SDKs that reject unknown fields fail closed after that field is written.

This interval applies to a still-open or deliberately deferred choice, rather
than automatically expiring an explicit refusal. Supervisory guidance warns
against repeatedly requesting a different answer after rejection; see the
[CNIL FAQ, question 21](https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies/FAQ).
Fourteen days is a product reminder interval, not a legally approved renewal
period. The separate history, profile-linking, and publication permissions
retain their existing one-time behavior.

- `set_opt_in(false)` saves baseline mode and discards unsent opt-in rows and
  batches. Metrics declared `opt_in` are skipped without evaluating their
  closures. Existing remote history is retained until deletion or expiry.
- `set_opt_in(true)` saves an affirmative choice and creates a random,
  tool/service/profile-scoped reporting identity when needed. It permits
  registered opt-in observations as well as eligible baseline observations.
- `set_disabled(true)` persists a complete analytics opt-out, discarding all
  unsent data. Downloads remain available. `set_disabled(false)` removes that
  restriction without manufacturing an opt-in choice.
- `delete()` disables collection, discards the queue, and schedules authenticated
  remote deletion. Follow it with `flush_in_background`. Pending deletion can
  resume on later invocations; offline mode prevents any network operation.
- `status()` exposes the saved choice, effective opt-in collection, disabled
  state, pending deletion, queue size, and dropped count. `preview()` returns
  local rows and immutable batch payloads, without credentials.

Functional version requests have a separate server-side statistics path;
[service statistics](service-statistics.md) need no local usage grant. Configure
`UpdateClient::with_service_metrics(false)` for a host-wide analytics opt-out.
No separate CLI analytics request is enabled by those server statistics.

The host passes process restrictions with `with_policy(telemetry::Policy)`.
`DO_NOT_TRACK`, host disable, invalid/off telemetry settings, and ineligible CI
contexts suppress collection. The host still maps its environment/flags,
supplies the permission reason, chooses the private profile root, and handles the
reserved worker entry. It maintains no separate opt-in file. Personal and CI
state remain separate, with explicit isolated CI authorization required.

The new client has its own versioned state file. It does not import legacy
grants or reuse legacy credentials. An identity expires after 90 days without
an acknowledged upload (or without its initial registration); active use does
not cause a recurring permission request. Renewing an expired identity requires
completing deletion before a new explicit grant.
Controls can return `Busy` while a bounded request owns the network lock. A
caller should report/retry that settings action rather than claim success.

### Explicit CI authorization

`request_opt_in` never opens a CI dialog. A deliberately configured operator
choice can instead call `set_opt_in(true)` for an isolated CI-run root, after
mapping `ci: true`, `ci_revision: Some("telemetry-v1".into())`, and
`isolated_ci_state: true` through `with_policy`. These fields are supplied by
the host; setting an environment variable alone does not configure this client.
Do not call `set_opt_in(true)` merely because CI was detected. A workflow/CI
setting may express authorization for that job; a cloned project file must not
silently grant consent on every developer's workstation. The SDK trusts this
host mapping and cannot verify who authorized it. Never reuse a personal root
or a shared cross-run cache. Functional service statistics apply independently
without this CI usage grant.

## Metrics and system context

There is one `record(metric_id, closure)` method. Each `Metric` declares
`Collection::OptOut` or `Collection::OptIn`, required finite categorical
dimensions, and `SystemContext::None`, `Platform`, or `Full`. There are no
per-event consent flags or unrestricted JSON properties.

The [canonical catalog](../contracts/event-catalog.json) owns the shipped
definitions. Its packaged Rust copy is checked byte-for-byte, and storage
tests compare the database's registered definitions with the catalog. The
shipped CLI, resource-download, and language-use definitions use opt-in. Tests
exercise baseline operation with isolated synthetic definitions.

System detection is implemented once in the SDK, after the effective policy
check. Platform context uses OS family and executable architecture. Full
context also provides normalized OS version and CPU family; Apple M-series
generations have categories such as `apple_m1` and `apple_m4`. Unknown hardware
remains `other`/`unknown`; raw model strings are not transmitted. Linux full
context separates distribution/version from kernel version. Full results are
cached within the client instance. Construction never triggers detection.

`with_project_context` accepts an owned lazy producer for the consuming
project's `RepositoryContext`. For metrics with project context enabled, it
runs at most once after effective opt-in. The SDK applies the existing shared
repository normalization and SHA-256 contract, reporting only `project_id` and
`project_id_version`. It never substitutes the dependency package's repository.
Missing context remains unknown; raw repository metadata is not persisted.

One successful `record` increments one counter. Hosts choose the unit and
instrumentation boundary; do not call it once per internal file operation and
then label the result CLI invocations. Each record performs local locked,
atomic persistence. There is no request per counter increment. This API is
not an in-memory, high-frequency highlighting profiler; define/deduplicate
language-use units before adding Ferriki hot-path instrumentation.

## Downloads

`download(resource, options)` performs a synchronous transfer needed by the
caller. It streams into a private temporary file, checks exact byte length and
SHA-256, then returns a `VerifiedDownload`. Its reader rewinds to byte zero;
its temporary path is available for the host's cache implementation. Dropping
the result removes the temporary artifact. The SDK owns no persistent resource
cache or cache directory layout.

`Resource::reporting(metric_id, dimensions)` associates a registered counter.
The client counts it only after successful integrity verification and schedules
due reporting in the background. Reporting failures/refusal do not fail an
otherwise valid resource transfer. The resource URL, descriptor ID, and digest
are not implicitly converted into analytics labels.

Requests use HTTPS, with numeric loopback HTTP accepted only for fixtures.
Userinfo, query strings, fragments, redirects, and encoded response bodies are
unsupported. No reporting credential, installation ID, project ID, or system
context is sent to resource hosts. Select a mirror by providing another
descriptor; there are no hidden transfer retries. Each concurrent call owns
one transfer. The cache owner coordinates duplicate cache misses if desired.

Options default to a 60-second request deadline and 128 MiB ceiling. The maximum
configured deadline is ten minutes. A shared `Cancellation` token is checked
before requests and between reads; a blocked read is bounded by the request
deadline. Cancellation, integrity, size, and HTTP failures never count success.
In offline mode the host uses its cache; a cache miss returns `Offline`.

## Delivery and rollout

`flush_in_background` claims at most one due operation and launches the current
executable. Network delivery has a five-second budget in that worker, with no
network or child wait in the foreground. Local disk operations and process
launch still occur there. The worker rechecks persisted settings and consumes
its short-lived one-use nonce before I/O. A completed refusal cannot race a
later request start. Windows uses the existing no-handle-inheritance launcher.

Counters aggregate by UTC day and complete dimensions, including tool version
and selected system context. Local state is capped at 4 MiB and 4,096 open
dimensions. Counts cap at one million per dimension. Old open rows are dropped
if needed to preserve the byte bound; the dropped count is inspectable. Queued
data expires after seven UTC dates. Immutable batches carry up to 64 rows and
60,000 bytes. A lost acknowledgement retries identical bytes and a stable
batch ID. Receipts must match both batch ID and payload hash.

Attempts are at least one minute apart; failed attempts back off through 1, 5,
30, 60, 360, and 1,440 minutes. Backlog drains with the minimum interval;
otherwise successful delivery defers the next upload for a day. No daemon is
installed. Short-lived hosts must wire the worker entry for delivery to work.

Apply [migration 0008](../db/migrations/0008-generic-events.sql) and the updated
runtime function grants before adopting the new endpoint. New generic counters
are separate from legacy invocation statistics. The private dashboard keeps these separate from legacy invocations and reads
fixed metric, version, language/resource, and system aggregates through migration
0009; its source view is `app_tracking.reporting_events_v1`.
Node support, cross-tool device identity, and Ferriki consumer adoption remain under [issue #48](https://github.com/sebastian-software/app-tracking/issues/48).
This client implementation does not claim those integrations are complete.

The [deployment runbook](deployment.md#published-unified-client-verification)
defines service-first rollout, old-artifact rollback behavior, and the live
consumer check against an exact crates.io release. Routine publication goes
through [Release Please](releasing.md); no manual version bump or tag is needed.

## Additional profile linking

The optional [profile contract](profile-linking.md) adds a separate per-tool
choice and a shared random local profile. Construction/ordinary recording never
creates it. CI remains excluded. Tool unlinking, authenticated ordinary deletion,
and shared-profile reset are different operations. Production enrollment remains
disabled pending its notice/review, and existing usage grants do not include it.
