# app-tracking

Shared advisory update checks and explicit opt-in usage reporting for Rust CLI
tools. Nothing runs on import or construction. Update checks remain independent
of telemetry and never read project metadata or create reporting state. The
library prints only when explicitly asked to show its permission dialog and
never installs or executes an update.

## Unified counters and resource downloads

`app_tracking::client::Client` provides `record`, `download`, and a saved
`request_opt_in(message)` dialog. The SDK owns the explanation, yes/no prompt,
and private saved decision, and automatically applies
each metric's registered collection route and system context. `set_disabled`
stops both routes; `set_opt_in(bool)` changes the saved decision explicitly;
`delete` requests authenticated deletion. The legacy
invocation and update APIs remain compatible.

```rust,no_run
use app_tracking::client::Client;
use std::collections::BTreeMap;
# fn main() -> Result<(), Box<dyn std::error::Error>> {
let client = Client::registered("https://tracking.example.com", "/private/profile", "palamedes", "2.0.0")?;
// At a suitable interactive point; saved yes/no answers are reused:
let permission = client.request_opt_in("Help prioritize Palamedes commands and platform support.")?;
let _ = client.record("cli.invocation", || BTreeMap::from([
    ("command".into(), "extract".into()),
]));
let _ = client.flush_in_background();
# Ok(())
# }
```

No dialog opens in CI or without terminal stdin/stderr. Use
`with_interaction(Interaction::Never)` for JSON/agent modes. `record` and
`download` never open dialogs. EOF leaves the choice undecided.

Handle `client::BACKGROUND_WORKER_ARGUMENT` before normal argument parsing and
call `run_background_worker` with its nonce. Reporting network I/O runs there;
ordinary calls still perform local persistence and worker launch. Downloads
synchronously return a temporary `VerifiedDownload` only after size/SHA-256
checks. Cache placement belongs to the host. Declined/failed reporting does
not prevent a verified download; cache reads are separate observations.

The service must have the matching event contract, migration, and runtime
grants before adopting this API. See the repository's
[`docs/unified-client.md`](https://github.com/sebastian-software/app-tracking/blob/main/docs/unified-client.md)
for settings, process policy, limits, cancellation, and rollout details.

## Optional monthly history

Ordinary usage grants do not include longer retention. The separate
`request_history_opt_in(reason)` dialog explains screened monthly summaries
retained for 24 months. `set_history_opt_in(bool)` saves a local choice,
`history_status()` exposes pending acknowledgement, and
`sync_history_permission()` sends it only when explicitly called from settings
(with a five-second total network budget). Register ordinary reporting first;
server eligibility starts on the UTC date after acknowledgement. Declining
ordinary reporting also queues a history withdrawal. Synchronize that change
from settings or complete authenticated deletion; offline changes stay pending.

The server feature remains disabled until its disclosure/review gate is met.
See [the history contract](https://github.com/sebastian-software/app-tracking/blob/main/docs/monthly-history.md)
for consent, deletion, downgrade behavior and the unchanged 90-day detail limit.

## Update checks

The synchronous update client uses a public version API with a separate cache.
It creates no installation identity, project hash, usage counter, or telemetry
request. The update API from 0.1 remains compatible.

```rust,no_run
use app_tracking::{Mode, Tool, UpdateClient};

# fn main() -> Result<(), Box<dyn std::error::Error>> {
let tool = Tool::new("dalo", "1.0.0", "npm", "stable")?;
let client = UpdateClient::new(
    "https://updates.example.com",
    "/path/to/host/cache/updates",
    tool,
)?;
if let Ok(Some(update)) = client.check(Mode::Enabled) {
    eprintln!("Update available: {}. Run: npm install -g getdalo", update.latest_version);
}
# Ok(())
# }
```

The example origin is a placeholder. The host selects its service endpoint,
cache directory, eligibility, and installation-specific instructions. Only tool,
distribution, and channel are sent in the GET path, with a fixed user agent and
an optional opaque ETag. Installed versions are compared locally using SemVer
precedence, including prereleases; build metadata cannot trigger an update.

A due call has one request with a 200 ms total network deadline, including DNS,
connection, TLS, headers, and body. It completes before returning. There is no
update worker that must survive process exit. Filesystem and scheduler overhead
are additional, so this is not an absolute wall-clock guarantee. The transport
may use a DNS worker internally; no update result depends on that worker after
the deadline.

Fresh successes suppress requests for at least one hour. Failures and stale
responses use 5, 10, 20, 40, then 60 minutes of backoff. Notices are offered at
most once per release per 24 hours, with an immediate opportunity for a newly
observed release. Retained metadata expires after 24 hours from source
validation. A stale result does not reset successful freshness.

`Mode::Disabled` and `Mode::Offline` perform no network or filesystem access and
offer no notice. Map the host's environment/configuration, CI, JSON, and terminal
policies to these modes; the library imposes no environment-variable names.
Treat errors as advisory and preserve the command's stdout and exit status.

An OS file lock prevents concurrent checks and duplicate notices without
waiting for a busy holder. Cache writes use temporary files and atomic
replacement. A pre-request retry claim survives abrupt process exit. Use a
local filesystem with working file locks; scope the cache directory to one
service endpoint. Different tools/distributions/channels use separate files.
Wrappers and native entry points must share the cache and designate one check
owner. Usually the native CLI owns the check and wrappers do not call it.
Library embedding does not automatically check anything.

## Opt-in telemetry

`app_tracking::telemetry::Client` supplies explicit consent controls, local
inspection/redacted preview, durable counters and immutable batches, bounded
registration/upload retries, withdrawal, and pending deletion. The host presents
the disclosure, resolves policy, and designates one native invocation owner.
There is no implicit reporting or consent from an update check. CI requires a
separate explicit isolated scope; offline can count locally after consent.

Use the [telemetry integration guide](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.3.0/docs/rust-telemetry-client.md)
for the API, state ownership, privacy boundaries, and known delivery losses.
`app_tracking::project` normalizes repository context lazily after consent; see
[normalization v1](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.3.0/docs/project-identity.md)
and the packaged golden fixtures. `run_in_background` durably records counts
and launches at most one due request in a short-lived copy of the same binary.
The host must handle `BACKGROUND_WORKER_ARGUMENT` before normal command parsing
and call `run_background_worker`. The calling process never waits for telemetry
networking; the worker has a five-second request deadline, private state, and
no inherited stdin/stdout/stderr. There is no permanent daemon. The explicit
legacy `run` API remains synchronous with its original 200 ms deadline.
Production telemetry enablement and consumer adoption are separate steps.

The update integration guide and release procedure live in the
[repository documentation](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.3.0/docs/rust-client.md).
Licensed under MIT OR Apache-2.0.
