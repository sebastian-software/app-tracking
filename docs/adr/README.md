# Architecture Decision Records

These records explain durable choices for app-tracking. Accepted means the
direction is decided, not that it is implemented or deployed.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-independent-service-and-gradual-adoption.md) | Independent service and gradual adoption | Accepted |
| [0002](0002-independent-updates-and-opt-in-telemetry.md) | Independent updates and opt-in telemetry | Accepted |
| [0003](0003-repository-derived-project-identity.md) | Repository-derived project identity | Accepted |
| [0004](0004-bunny-hosting-and-planetscale-storage.md) | Bunny hosting and PlanetScale storage | Accepted |

Use sequential, zero-padded filenames. An ADR records context, the decision,
and its consequences. The status vocabulary is Proposed, Accepted, Rejected,
Deprecated, or Superseded.

Preserve accepted decisions as historical records. Correct non-semantic errors
in place; change a decision through a successor ADR with links in both
directions. Do not rewrite an accepted decision to conceal a change in
direction.

[RFCs](../rfcs/README.md) own the detailed proposals. If an RFC conflicts with
an accepted ADR, resolve the decision before implementing the conflicting
proposal. Exact limits and API shapes remain proposals until implemented and
verified; this index is not an implementation-status tracker.
