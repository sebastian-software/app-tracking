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

Rust and Node support independent update checks, ordinary reporting, reminders, verified downloads, and
separate history, public usage, and shared v2 profile choices. General usage
consent never silently enables an additional permission. The v2 profile tests
exercise actual Rust and installed Node clients, including both creation orders
and concurrent access. See [#54](https://github.com/sebastian-software/app-tracking/issues/54)
and the [profile guide](profile-linking.md) for the contract and evidence.

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

[#98](https://github.com/sebastian-software/app-tracking/issues/98) adds Node's
optional `CliClient` convenience surface. Its promise ownership, AbortSignal,
one-command deduplication, and async disposal fit Node's lifecycle. Rust already
offers synchronous operations and a reserved host-worker entry; adding the same
async wrapper would not remove those host responsibilities. No Rust convenience
class is planned or required for acceptance. The compiling
[`cli-integration` example](../crates/app-tracking/examples/cli-integration.rs)
shows equivalent composition with the existing APIs. The Node guide includes
the host/SDK boundary and an Ardo integration example; adoption remains in Ardo.

Both clients execute `contracts/cli-settings.json` for explicit choices,
withdrawal/discard, disabling, pending offline deletion, policy vetoes, and
independent CI grants. Existing low-level authenticated-deletion tests remain
in both runtimes; the Node wrapper additionally verifies acknowledged delivery,
unchanged command output/exit status, and completion on success/failure/interruption.
The wrapper does not add a new consent, identity, reporting, or server contract.

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
