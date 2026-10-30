# Rust and Node.js client parity

Shared client features should ship in Rust and Node.js in the same PR. The
repository's [agent instructions](../AGENTS.md) require both implementations to
be checked, equivalent behavior to be verified, and any exception to be visible.
A shared release version is not a claim that every API already exists in both
clients. The initial Node client covers the event-reporting and verified-download
scope of [#53](https://github.com/sebastian-software/app-tracking/issues/53).

## Existing gaps

### Additional permissions

Rust and Node both support separately permitted history and public usage totals.
Both clients support a separately selected v2 shared profile. Rust also retains
legacy v1 controls; Node does not access v1. See the [profile guide](profile-linking.md)
for reset and migration boundaries.

Closing these gaps requires the corresponding independent permission flows and
equivalent authorization, withdrawal, and deletion behavior. A general usage
grant must never silently enable an additional permission.

## Maintaining the baseline

Update these notes when a gap is closed or a deliberate exception is introduced.
New shared behavior defaults to implementation in both clients; the existing
backlog is not permission to add more undocumented differences. Keep the feature's
contract, both implementations, and verification evidence together in its PR.
