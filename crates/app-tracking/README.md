# app-tracking 0.1

The repository also contains an **unreleased** consent-gated project identity
module, `app_tracking::project`, with no discovery I/O or automatic collection.
See the [normalization v1 contract](https://github.com/sebastian-software/app-tracking/blob/main/docs/project-identity.md)
and the packaged `fixtures/project-identity-v1.json` golden vectors. The published
0.1.0 release remains the update-only client described below.

A synchronous Rust client for the app-tracking version API. This release performs
update checks only. It creates no installation identity, repository hash, usage
counter, telemetry queue, or analytics request. It prints nothing and never
installs or executes an update.

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

The integration guide and release procedure live in the
[repository documentation](https://github.com/sebastian-software/app-tracking/blob/main/docs/rust-client.md).
Licensed under MIT OR Apache-2.0.
