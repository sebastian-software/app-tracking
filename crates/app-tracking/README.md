# app-tracking 0.2

Shared advisory update checks and explicit opt-in usage reporting for Rust CLI
tools. Nothing runs on import or construction. Update checks remain independent
of telemetry and never read project metadata or create reporting state. The
library prints nothing and never installs or executes an update.

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

Use the [telemetry integration guide](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.2.0/docs/rust-telemetry-client.md)
for the API, state ownership, privacy boundaries, and known delivery losses.
`app_tracking::project` normalizes repository context lazily after consent; see
[normalization v1](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.2.0/docs/project-identity.md)
and the packaged golden fixtures. The client makes at most one synchronous
telemetry request per run with a 200 ms network deadline, without a worker.
Production telemetry enablement and consumer adoption are separate steps.

The update integration guide and release procedure live in the
[repository documentation](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.2.0/docs/rust-client.md).
Licensed under MIT OR Apache-2.0.
