# Rust telemetry client: 0.2

`app_tracking::telemetry::Client` implements explicit opt-in collection,
registration, durable batches, and deletion. Import and construction do nothing
automatically. The existing `UpdateClient` API and cache remain independent;
declining telemetry never disables updates. The production service still exposes
version routes only. Issue #11 owns production telemetry enablement; Palamedes adoption belongs to #15 and is the first v2 consumer; Dalo adoption
belongs to #12.

## Host integration

The host presents the [common disclosure](telemetry-consent.md) before an
affirmative decision and maps its controls to `Control`. No prompt, TTY test,
automatic grant, or policy-environment detection lives in the library. The HTTP
transport may honor standard proxy settings. An agent must not
manufacture the human decision.

```rust,no_run
use app_tracking::project::{Origin, RepositoryContext};
use app_tracking::telemetry::{Client, Invocation, Policy};

# fn main() -> Result<(), Box<dyn std::error::Error>> {
let client = Client::new("https://updates.example.com", "/private/profile/tracking", "dalo")?;
let policy = Policy::default(); // Map actual host settings/environment below.
let result = client.run(
    &policy,
    Some(Invocation { command: "sync", tool_version: "1.10.0" }),
    || RepositoryContext { origin: Origin::Absent, package_json: None },
    false,
);
// Treat errors as advisory; preserve the command's existing output and status.
let _ = result;
# Ok(())
# }
```

Use one designated native CLI entry point after successfully parsing and
dispatching a countable command, after command work and regardless of its exit
status. npm wrappers do not count again. Embedded library use does not call the
client automatically. Exclude help/version, completions, manpages, telemetry
controls, assistant maintenance, and automatic/background work. Pass `None`
when only retrying a pending operation or explicitly flushing. The initial
catalog accepts Dalo and Palamedes; unmapped categories become `other`, never arbitrary data.
Installed SemVer is limited by the wire contract. Pass no arguments or errors.

Project discovery belongs inside the lazy closure, which is invoked only for
an eligible count after effective collection consent. Supply the configured Git
origin and, only if absent, the relevant package metadata as described in
[normalization v1](project-identity.md). Unknown/global context contributes
ordinary usage without project fields. No raw repository metadata is stored.

### Policy mapping

| Host input                        | `Policy` field                            | Effect                                                             |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `DO_NOT_TRACK=1`                  | `do_not_track`                            | Hard collection/upload veto; discard unsent usage                  |
| Host telemetry disabled           | `host_disabled`                           | Same veto; does not change the stored decision                     |
| `APP_TRACKING_TELEMETRY`          | `telemetry`                               | Absent/`on` evaluates consent; `off` or invalid values veto        |
| `APP_TRACKING_CONSENT`            | `environment_consent`                     | Exact `telemetry-v1` is an informed process/deployment grant       |
| Host CI detection                 | `ci`                                      | CI cannot inherit local state or consent                           |
| `APP_TRACKING_CI`                 | `ci_revision`                             | CI additionally requires exact `telemetry-v1`                      |
| Isolated `APP_TRACKING_STATE_DIR` | constructor root plus `isolated_ci_state` | Host attests a private root unique to this CI run                  |
| Host offline setting              | `offline`                                 | No networking, including deletion; permitted local counts continue |

Persisted decline/withdrawal beats an environment grant. A stored explicit
grant survives absence of the environment value. An environment grant stores
its original declaration/identity for retries but never becomes persistent
permission: removing the environment value clears unsent usage and stops
reporting. Reintroducing the same nonexpired grant reuses that authority.
An invalid revision does not become new consent. Neither non-TTY nor JSON
output is a veto or evidence of agent use. Status and preview do not send.

### Controls and inspection

`control(operation, policy)` persists an explicit local operation and sends
nothing. `Enable` must follow disclosure and an affirmative human decision.
`Decline`/`Withdraw` immediately clear counters, queued/conflict payloads, and
the grant. They keep only decision/authority metadata needed for recovery or
explicit deletion; they do not implicitly contact the server.

`Delete`/`Reset` withdraw first, retain only authority and deletion status, and
mark deletion pending. Call `run(policy, None, ..., false)` to make one eligible
attempt, or let later ordinary invocations retry while online. `DO_NOT_TRACK`
does not veto that explicit deletion; offline does. Pending deletion blocks a
new Enable. Reset/renewal require completing old deletion and another explicit
Enable; they do not silently rotate IDs. `ForgetUnverified` explicitly abandons
local authority while preserving an unverified-deletion result, after which a
separate grant is possible. This operation cannot confirm remote deletion.

Only empty authenticated 204 confirms deletion. A validated
`installation_not_found` 404 records `NoActiveRecord`, without claiming a new
deletion occurred. Retryable/pending 503 retains the same authority; malformed
acknowledgements do not confirm completion. After 90 days pending deletion
expires locally as `Unverified` and discards its credential. A never-registered
offline grant has no remote identity to delete.

`status(policy)` shows effective policy/reason, decision/source/revision/time,
local/CI context, locally held installation ID, queue/drop totals, retry time,
terminal HTTP status, and deletion state. `preview(policy)` additionally renders
exact immutable batches, registration declaration, and open rows not yet closed
into a batch. Both redact credentials and perform no request. Existing expired
or vetoed usage is removed locally; neither command creates initial state.

Controls return `Busy` if another process owns the state or bounded network
request. The host must retry or report that the control did not complete; it
must never display a successful withdrawal before the operation commits.
Ordinary busy/unwritable calls may omit a count and must not fail the command.

## Private local state

Use a host-owned private profile root. The client adds the SHA-256 of the
validated service origin, tool, and `local`/`ci` directory components. Installation
identity is shared across versions, wrappers, projects, and clones of that tool
within that root, but not across tools, origins, profiles, or CI runs. The host
must provide a different isolated root per CI run, not a developer profile or
a shared CI cache. Never put this root in a repository.

State schema 1 is one bounded `state.json`, a stable `state.lock`, a separate
`network.lock`, and a reserved uncommitted `state.new`. Unix-created directories
are 0700 and files 0600; permissive existing leaf directories/files and symlinks
are rejected. On Windows, the host must select a profile/CI root with private
inherited ACLs: std filesystem permissions do not verify arbitrary Windows ACLs.
Administrators and processes running as the same user are outside this boundary.
Use a local filesystem with working OS locks and atomic replacement.

Writes flush and sync a complete private temporary file before rename; Unix
also syncs the directory. A crashed uncommitted file is discarded under the
state lock before another operation. Invalid, oversized, unknown-schema, or
wrong-scope state fails closed and is preserved; it never silently creates a
replacement identity. The original credential is needed to delete old remote
data if state is lost. An explicit `ForgetUnverified` may discard a corrupt or
unknown-schema private state file, acknowledging unverified remote deletion;
it still rejects symlinks and nonprivate files. There is no token in argv, a
URL, preview, or an error.

The short state lock protects increments, closures, claims, and acknowledgements.
A separate nonblocking network lock covers transmission and control changes.
Counters can advance during HTTP. Withdrawal commits outside transmission;
late acknowledgements match the generation/attempt and cannot resurrect a grant
or erase newer counts. Process exit releases OS locks. Persisted attempt/backoff
claims prevent immediate retries after a crash.

## Queue, cadence, and failures

The packaged policy JSON mirrors the service's limits; a cross-runtime check
prevents drift. Open dimensions use canonical keys, aggregate by occurrence UTC
day/version/command/project, and close atomically into canonical, sorted batches.
The client generates UUIDv7 and a separate CSPRNG 256-bit token only immediately
before the first online registration attempt. Offline consent/counts create no
installation ID or token. Registration success cannot upload in the same call.

First ordinary closure/upload is due after 24 hours of counting. Subsequently
drain at most one queued batch per invocation with at least 60 seconds between
attempts; after draining, ordinary closure is due 24 hours later. Explicit flush
can close earlier, including the current CI day, but cannot bypass suppression.
New counters are never merged into a possibly submitted batch. ACKs require the
exact schema, status, installation, batch, payload SHA-256, and valid receipt
timestamp before removing that matching batch. Unknown outcomes retry the same
ID, token, declaration, and immutable bytes. Duplicate receipts do not extend
authority inactivity.

Honor 4 MiB serialized usage state, 4,096 open dimensions, 64 pending batches,
256 rows/65,536 bytes per batch, row/batch/daily count limits, and seven eligible
UTC occurrence dates. Prune expired whole batches/open rows first; if full,
drop oldest unsent whole batches or the oldest open day. Expose dropped counts
locally, without adding a wire field. Conflicts remain inspectable within those
bounds. There is no lossless-delivery promise. Busy stores, queue bounds,
offline expiry, stopped tools, reset/lost state, and last-unuploaded activity
can omit usage.

Network waiting is synchronous, at most one request per run, with the existing
200 ms total DNS/connect/TLS/headers/body budget. No redirect, detached upload,
subprocess worker, or daemon is used. Bodies are bounded to 2 KiB and headers
to 16 KiB. Fixed user agent: `app-tracking-telemetry-client`. Filesystem,
serialization, process startup, and scheduling are additional; independent
update waiting can add another 200 ms when due.

Persist backoff before sending: 1 min, 5 min, 30 min, 1 h, 6 h, then 24 h capped.
Connection/unknown outcomes, 429, 503, and other 5xx preserve the same operation.
Combine bounded Retry-After with local backoff using the later deadline. A
malformed/mismatched success is unknown, not an ACK. Terminal 400/401/404/409/
410/413/415 pauses unchanged retries, without re-registration/reset. A 410 also
clears unsent data and requires new consent. Local/server inactivity at 90 days
requires explicit renewal. Clock problems never re-date old counts or IDs.

## Verification and release

Run the existing [Rust checks](rust-client.md#verification-and-release), plus
`node scripts/check-rust-telemetry.ts` after building examples. The actual client
executes packaged consent/canonical vectors. Tests cover snapshot closure,
crash claims, new counts during upload, generation-safe late ACKs, policy vetoes,
CI isolation, queue/age bounds, terminal errors, and pending deletion.

The cross-platform process harness uses the real HTTP handler and synthetic
storage fixture for wire behavior, not SQL correctness. The PostgreSQL CI job
and explicit `ingestion_test` workflow inject real storage into that same
process harness, including PlanetScale's actual HTTP driver for the latter.
Only owned synthetic installations are used and removed afterward. A fixture
edits its own next-attempt timestamps to avoid minute-long sleeps; the production
API has no retry-bypass switch. Unit tests exercise the real suppression rules.
Production private Bunny routes require the explicit activation and deployed
evidence described in [operations](operations.md) (#11). Canonical bytes are
also verified with a consumer-enabled `serde_json/preserve_order` feature;
dependency feature unification cannot change the payload hash.

Local candidate measurement on 2026-10-26, macOS ARM64, debug example processes
and an isolated PostgreSQL 18.6 container: 16 concurrent processes passed; a
registration acknowledgement process took 81 ms, and the median cached/counting
process took 17 ms. A deliberately stalled response returned in 230 ms including
process/filesystem overhead. The first disabled example launch took 371 ms;
startup is not a universal 200 ms wall-clock guarantee. Each CI/live harness run
prints its own sanitized process measurements. These observations are not
production Internet latency or capacity claims.

The crate version is 0.2.1. Package verification includes all source, examples,
licenses, policy, identity, and telemetry vectors. Publication uses the existing
Cargo credential provider and `app-tracking-v0.2.1` tag, separately from consumer
adoption and service deployment. No telemetry is enabled merely by upgrading.
