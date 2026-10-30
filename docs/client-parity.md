# Rust and Node.js client parity

Shared client features should ship in Rust and Node.js in the same PR. The
repository's [agent instructions](../AGENTS.md) require both implementations to
be checked, equivalent behavior to be verified, and any exception to be visible.
A shared release version alone does not establish feature parity.

## Current baseline

Rust and Node support ordinary reporting, reminders, verified downloads, and
separate history, public usage, and shared v2 profile choices. General usage
consent never silently enables an additional permission. The v2 profile tests
exercise actual Rust and installed Node clients, including both creation orders
and concurrent access. See [#54](https://github.com/sebastian-software/app-tracking/issues/54)
and the [profile guide](profile-linking.md) for the contract and evidence.

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
