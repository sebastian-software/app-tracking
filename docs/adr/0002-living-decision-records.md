# ADR 0002: Living decision records

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-22

## Context

The initial ADR index treated accepted records as immutable and required a
successor for a changed decision. This project is still developing its
contracts. Readers need to find the current decision in one place as the
design gains implementation and operational evidence.

## Decision

I maintain ADRs as living documents. Each record contains the current decision,
its rationale, scope, and consequences. Semantic changes to an accepted ADR
are made in that file through the normal repository review process. Acceptance
records a decision; it does not assert that implementation or deployment is
complete. Editing a file alone does not authorize a new project decision.

This convention applies to all existing and future records in `docs/adr/`.
Keep sequential, zero-padded filenames and stable numbers. Do not renumber or
rename a record merely because its decision evolves. Create a separate ADR
for a separate decision that needs its own rationale and scope.

Each ADR has a status, its original `Date`, and `Last updated`. For a semantic
change, preserve the original date, update `Last updated`, and append a short,
dated entry under `Change history` explaining what changed and why. Pure
spelling or formatting corrections need no change-history entry. Earlier
versions and detailed diffs remain in Git history; do not rewrite history to
hide a previous decision.

Use these statuses consistently:

| Status     | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| Proposed   | Under discussion; not a binding project decision                     |
| Accepted   | Current project direction, whether implemented yet or not            |
| Rejected   | Considered and not adopted                                           |
| Deprecated | No longer applicable, without a direct successor                     |
| Superseded | Replaced by a different record because its identity or scope changed |

A normal revision needs no successor ADR. If a split, consolidation, or change
of scope does require one, link old and new records and update the index so the
current owner is clear. Update affected RFCs, references, and glossary terms in
the same change, or explicitly identify any remaining conflict before work
depends on it.

ADRs own decisions and reasoning. Issues own delivery order and implementation
status. RFCs own proposals; maintained contracts, code, configuration, and
runbooks own executable details. There is no exception for storing credentials,
private deployment details, or real telemetry in an ADR.

## Consequences

- Readers find current direction without following a chain of superseded ADRs.
- Older reasoning may require Git history; dated change notes make substantive
  revisions discoverable without preserving every prior paragraph in place.
- Every semantic edit must reconcile the decision and its consequences, not
  merely append a contradictory note.

## Change history

- 2026-10-22: Replaced the initial immutable convention with living records to
  keep current decisions discoverable in a stable location.
