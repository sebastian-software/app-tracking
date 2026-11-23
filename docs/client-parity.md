# Rust and Node.js client parity

Shared client features should ship in Rust and Node.js in the same PR. The
repository's [agent instructions](../AGENTS.md) require both implementations to
be checked, equivalent behavior to be verified, and any exception to be visible.
A shared release version alone does not establish feature parity.

The [README comparison](../README.md#rust-and-nodejs-side-by-side) lists client
capabilities in both languages. The [paired integration guide](client-comparison.md)
shows the same tasks in Rust and Node.js, including runtime differences. Keep
both examples current in the feature's PR so a missing implementation is visible
at the integration entry point, as well as in its tests.

## Current baseline

Rust and Node support independent update checks, ordinary reporting, reminders, verified direct and signed downloads, and
separate history, public usage, and shared v2 profile choices. General usage
consent never silently enables an additional permission. The v2 profile tests
exercise actual Rust and installed Node clients, including both creation orders
and concurrent access. See [#54](https://github.com/sebastian-software/app-tracking/issues/54)
and the [profile guide](profile-linking.md) for the contract and evidence.

Both clients validate download resource IDs against the same grammar before
transfer. `contracts/download-resource-ids.json` covers their shared boundaries;
its Rust fixture copy is checked for equality. The signed URL contract is verified
with `contracts/signed-download-urls.json` and a matching packaged Rust fixture.

## Update and CLI integration contracts

[#97](https://github.com/sebastian-software/app-tracking/issues/97) closes the
Node update-client gap. Both implementations execute `contracts/update-client.json`
(mirrored unchanged into the packaged Rust fixtures): local SemVer precedence,
timestamp/route validation, freshness/expiry, backoff, notices, and actual
conditional HTTP responses. Each keeps the existing 200 ms network budget.
Node additionally tests cancellation, installed processes, crash recovery, and
the packed CJS/ESM/declaration boundary on Node.js 22, 24, and 26. Rust retains
its synchronous API and existing three-platform consumer/deadline tests.

Update caches intentionally remain separate: Rust uses OS locks, Node uses its
existing pure-JavaScript lease mechanism and `node-updates-v1` namespace. They
implement the same cadence, but do not coordinate a notice between runtimes.
Hosts must designate one update-check owner when exposing both entry points.
This is a runtime-specific persistence boundary, not a shared cache format.

[#98](https://github.com/sebastian-software/app-tracking/issues/98) introduced
Node's optional `CliClient`. Both SDKs now provide optional CLI composition
with a single observation and completion per command. Rust uses synchronous
calls and a helper for its reserved host worker argument. Node retains its
package-owned worker, promise ownership, AbortSignal, and async disposal.
Neither API implicitly asks for permission or attaches itself to the host
command lifecycle. Update checks remain independent of reporting.

Both clients execute `contracts/cli-settings.json` for explicit choices,
withdrawal/discard, disabling, pending offline deletion, policy vetoes, and
independent CI grants. Both also test interactive reconsideration of a saved
refusal, a fresh affirmative answer after disabling, and generation-safe
refusals. An explicit CI action requires the current disclosure revision,
isolated state, and a real operator grant. Repeating deletion preserves the
pending retry schedule. The same hosted-service notice is packaged in both SDKs.
The Git helpers read a single raw local origin and distinguish verified absence
from failed or ambiguous lookup. Existing consent, identity, reporting,
persistence, and server contracts continue to apply.

## Background worker state contention

Both clients briefly retry a busy private-state lock in the background worker,
including when persisting upload and deletion acknowledgements. Foreground
status/settings calls remain nonblocking. Rust uses the legacy worker's 100 ms
retry window; Node retains its existing 500 ms window for asynchronous leases.
These runtime-specific bounds do not extend the update-check network deadline.
If contention outlasts the bound, the worker returns `Busy` and leaves the
unacknowledged operation pending. Network exclusion, consent checks, and
generation-safe acknowledgements remain unchanged.

Rust regression tests use a real subprocess, OS state locks, and loopback HTTP
for upload and deletion at initial claim and acknowledgement. Installed Node
package tests cover the same acknowledgement contention and pending deletion
after its retry window. Node's existing retry implementation already satisfies
this behavior; the production fix is in the Rust worker.

## Intentional legacy v1 exception

Rust retains its legacy v1 profile controls and files. That format uses an OS
file lock unavailable to the pure-JavaScript Node package, so Node does not read
or migrate v1 profiles or their choices. Each tool must make a fresh explicit v2
choice; Rust hosts retain legacy controls for existing v1 state. The shared v2
format and its cross-runtime tests provide the common path without changing
released v1 behavior.

## Maintaining the baseline

Update these notes when a gap is closed or a deliberate exception is introduced.
New shared behavior defaults to implementation in both clients; the existing
backlog is not permission to add more undocumented differences. Keep the feature's
contract, both implementations, and verification evidence together in its PR.
