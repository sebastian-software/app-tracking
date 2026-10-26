# ADR 0008: Background telemetry delivery

- Status: Accepted
- Date: 2026-10-26
- Last updated: 2026-10-26

## Context

The initial client waited synchronously for a telemetry request with a 200-ms
deadline after the CLI command. A production consumer test could not acknowledge
three registration attempts; an idempotent control request succeeded in about
292 ms. Increasing the foreground deadline would make telemetry delay command
completion. A detached thread alone cannot finish reliably after a short-lived
Rust CLI exits.

## Decision

Ordinary CLI telemetry does not wait for network delivery. The shared Rust client
persists counts and reserves an immutable operation locally, then starts a
short-lived copy of the same binary with an internal worker entry. That entry
loads current private state and policy, sends at most one due request with a
bounded network deadline, and exits. No permanent daemon or separate installed
helper is required. The host owns the early worker entry and never routes it
through normal commands, project discovery, updates, or usage counting.

Preserve explicit consent, CI isolation, offline/veto behavior, durable bounded
queues, network exclusion, generation-safe acknowledgement, and existing retry
suppression. The handoff contains local operation metadata only; no credential,
payload, or reporting identity is passed as a command argument. The worker
rechecks state before sending. An in-flight request retains the existing Busy
control semantics. Failed or killed workers leave queued operations available
for later invocations without inventing fresh identities.

Explicit flush/deletion controls schedule an operation and expose its pending
or acknowledged state. Update checks remain independently configured and keep
their existing API and foreground budget. The prior explicit synchronous Rust
API remains compatible; CLI consumers adopt the new background entry deliberately.

## Consequences

- Ordinary commands pay local persistence and spawn cost, not telemetry network
  latency. This is not a promise of zero filesystem/scheduler overhead.
- A worker can outlive its parent and has no inherited command output streams.
  CI/container/job teardown can still kill it; delivery is bounded and best effort.
- Hosts must implement and test the reserved early entry on supported platforms.
  A real process test holds the server acknowledgement until the parent exits.
- This changes delivery ownership, not report fields, purposes, consent revision,
  database schema, or retention. Exact budgets and handoff format live in the
  [client guide](../rust-telemetry-client.md) and code.

## Change history

- 2026-10-26: Replace foreground telemetry waiting with a bounded subprocess
  worker after production timing evidence and selection of nonblocking delivery.
