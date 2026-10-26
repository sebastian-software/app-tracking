# Rust update client: 0.1

The `app-tracking` crate implements the [version API](version-api.md) without
telemetry. The host configures one service origin, tool, installed SemVer,
distribution, channel, and local cache directory. Nothing runs on import or
construction. This is the shared client from issue #3; consumer migration and
release evidence belong to the adoption issues.

The repository additionally implements the unreleased
[`app_tracking::project` module](project-identity.md) from issue #9. It is an
explicit, consent-gated identity operation and is never used by update checks.
The published 0.1.0 version does not yet contain this module. A later crate
release and consumer adoption remain separate from this implementation.

## Host integration

```toml
[dependencies]
app-tracking = "0.1"
```

Use `Tool::new(id, installed, distribution, channel)`, then
`UpdateClient::new(origin, cache_dir, tool)` and `check(mode)`. The crate README
contains a compiling example. The origin must use HTTPS without credentials,
query, fragment, or a path prefix. Numeric loopback HTTP is supported for local
integration tests. Origins in examples are placeholders; the host selects its
real service address.

The host owns these decisions:

1. Select the tool's shared GitHub release feed: for example,
   `Tool::new("dalo", installed, "github", "stable")`. The service reads
   oss-metrics and applies the one-hour minimum release age. Detect the local
   installation separately to render npm, Homebrew, or other upgrade guidance.
   Do not split checks or cache state by installation method. Earlier `npm` and
   `standalone` API labels remain aliases; they do not certify registry readiness.
2. Map update/offline configuration to `Mode::Enabled`, `Mode::Disabled`, or
   `Mode::Offline`. Preserve existing disable settings. CI, JSON output, and
   terminal eligibility remain host policy. The HTTP transport may honor
   standard proxy environment settings.
3. Choose a host-owned local cache directory scoped to the service endpoint.
   Use a filesystem with working file locks. Tool/distribution/channel entries
   have separate files. The library creates no home-directory configuration.
4. Designate one check owner, usually the native CLI. npm wrappers should not
   also check. If multiple entry points can own checks, pass the same cache
   directory and route so their processes share throttling and notices.
5. Call synchronously at a command-controlled point, typically after its main
   work. Render `Ok(Some(Update))` with host-authored installation guidance on
   the appropriate output stream. Treat `Err` as advisory; preserve command
   stdout and exit status. `Ok(None)` includes current, suppressed, busy, and
   disabled checks. No output or logging is performed by the client itself.

`Update` contains `latest_version`, `release_url`, and `stale`. It contains no
server-provided shell command. The host can display a release link; it must
never execute it. This library does not replace binaries.

## Cadence, state, and failure behavior

A fresh successful response suppresses another request for at least one hour.
The installed version remains local and is compared using SemVer precedence:
a stable release can supersede a prerelease of that same version, an older
stable release cannot downgrade a newer prerelease, and build metadata alone
never triggers a notice. The current service returns only stable releases.

Failures and valid stale responses use 5, 10, 20, 40, then 60 minutes of backoff.
There is one HTTP attempt per due invocation and no polling while idle.
Notices are offered at most once per release per 24 hours, while a higher
release can be offered immediately. A temporarily older server result cannot
reset that throttle. An offered notice is recorded before returning, so an
abrupt host exit may lose that notice rather than duplicate it.

A nonblocking OS lock covers cache reads, the check claim, transport, and notice
selection. A busy invocation returns immediately. Before a request, the client
atomically persists the retry claim. If its process is killed, the lock is
released and the claim suppresses an immediate retry. Writes use temporary files
and replacement; invalid, oversized, or unknown-schema cache files are ignored
and repaired by a later successful check. Update-only cache schema 1 contains
release metadata, its resource URL and opaque ETag, next-check/backoff state,
and the last offered notice. There is no installation ID, project hash, usage
counter, consent token, or telemetry queue.

The response must match schema, tool, distribution, and channel. Metadata and
UTC timestamps are checked, links must be HTTPS without credentials or control
characters, and retained results expire at 24 hours from source validation.
A cached result older than one hour is marked stale when offered locally.
Neither retries nor 304 responses replace the original `checked_at` value.
Validators remain opaque, including Bunny's weak ETags. Redirects are not
followed; intermediary error bodies need not be JSON. JSON bodies and response
headers are each bounded to 16 KiB. Errors omit response bodies, paths, and URLs.

## Process lifetime and latency

A due call completes synchronously with a 200 ms total network deadline covering
DNS, connection, TLS, headers, and body. The client does not detach update work
that must finish after the CLI exits. The transport uses a DNS worker when
necessary to bound resolver waiting, but a late DNS answer performs no update
request or cache write after this call returns.

Cached and disabled calls perform no network work. A cache lock is never waited
on. Filesystem/scheduler overhead remains outside the network budget, so 200 ms
is not an absolute wall-clock guarantee. Local integration measurements report
cold and cached example-process time, plus disabled-process baseline; these
measure a small debug CLI against a synthetic local service, not production
Internet latency or a universal startup guarantee. The tests also stall real
HTTP headers and body streaming to verify the network timeout.

Local measurement on 2026-10-23 (macOS ARM64, debug example, synthetic loopback
handler): the first process after rebuilding took 272 ms; a subsequent cold-cache
run took 27 ms. Cached and disabled process medians over ten runs each were
both 3 ms. These are complete process durations, including startup and shutdown.
The first-launch result illustrates why the network deadline is not a complete
process-time guarantee. Cross-platform CI prints its own measurements.

## Verification and release

The root Cargo manifest owns the MSRV. The lockfile records the checked
resolution. The Rust workflow runs on Linux, macOS, and Windows, including
Clippy, tests/doctests, example build, the TypeScript-handler consumer check,
rustdoc, and package verification. The service remains a separate TypeScript
bundle and does not require Rust at runtime.

From the repository root, using the manifest's toolchain version:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace
cargo build --locked --examples
node scripts/check-rust-consumer.ts
RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps
cargo package --locked -p app-tracking
```

The synthetic consumer uses the real service handler and a synthetic oss-metrics snapshot. It
verifies host-supplied guidance, unchanged stdout and deliberately nonzero exit
status, unsupported distributions, zero disabled/offline traffic, and twelve
concurrent processes sharing one lookup and one notice. Normal checks contact
no public source or Bunny endpoint.

To release, update the crate version, run these checks from a clean committed
checkout, inspect `cargo package --list -p app-tracking`, then publish:

```sh
cargo publish --locked -p app-tracking
```

Use Cargo's configured credential provider or registry token; never commit a
token. Tag the published commit `app-tracking-v<VERSION>`. Retain `Cargo.lock`
for release verification. Publication is separate from consumer rollout and
from deploying the version service. A crate cannot be overwritten after
publication; later fixes use a new version.
