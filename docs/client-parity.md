# Rust and Node.js client parity

Shared client features should ship in Rust and Node.js in the same PR. The
repository's [agent instructions](../AGENTS.md) require both implementations to
be checked, equivalent behavior to be verified, and any exception to be visible.
A shared release version is not a claim that every API already exists in both
clients. The initial Node client covers the event-reporting and verified-download
scope of [#53](https://github.com/sebastian-software/app-tracking/issues/53).

## Existing gaps

### Deferred consent reminders

Rust gained `request_opt_in_reminder` in
[#69](https://github.com/sebastian-software/app-tracking/pull/69).
Node currently has only the one-time `requestOptIn` flow. This is an open parity
gap under [#53](https://github.com/sebastian-software/app-tracking/issues/53), not
an intentional difference in consent policy.

The Node implementation must follow the
[same reminder contract](unified-client.md#optional-14-day-reminders): explicit
yes/later/never choices, a 14-day cooldown after a claimed prompt, permanent
respect for refusals and withdrawals, no dialog in unattended or restricted
contexts, and no reporting identity or observations created by deferral alone.
Tests must cover the cooldown boundary, clock rollback, abandoned/concurrent
prompts, and a concurrent refusal winning over an affirmative answer.

### Additional permissions

Rust supports separately permitted history, public usage totals, and cross-tool
profile linking. The initial Node client does not expose these APIs, as recorded
in its [README](../packages/node-client/README.md) and the remaining Node work in
[#53](https://github.com/sebastian-software/app-tracking/issues/53).

Closing these gaps requires the corresponding independent permission flows and
equivalent authorization, withdrawal, and deletion behavior. A general usage
grant must never silently enable an additional permission.

## Maintaining the baseline

Update these notes when a gap is closed or a deliberate exception is introduced.
New shared behavior defaults to implementation in both clients; the existing
backlog is not permission to add more undocumented differences. Keep the feature's
contract, both implementations, and verification evidence together in its PR.
