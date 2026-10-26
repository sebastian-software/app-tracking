# Architecture Decision Records

These records explain durable choices for app-tracking. Accepted means the
direction is decided, not that it is implemented or deployed.

| ADR                                                      | Decision                                 | Status   |
| -------------------------------------------------------- | ---------------------------------------- | -------- |
| [0001](0001-english-project-language.md)                 | English project language                 | Accepted |
| [0002](0002-living-decision-records.md)                  | Living decision records                  | Accepted |
| [0003](0003-independent-service-and-gradual-adoption.md) | Independent service and gradual adoption | Accepted |
| [0004](0004-independent-updates-and-opt-in-telemetry.md) | Independent updates and opt-in telemetry | Accepted |
| [0005](0005-repository-derived-project-identity.md)      | Repository-derived project identity      | Accepted |
| [0006](0006-bunny-hosting-and-planetscale-storage.md)    | Bunny hosting and PlanetScale storage    | Accepted |
| [0007](0007-dual-license.md)                             | MIT or Apache-2.0 licensing              | Accepted |
| [0008](0008-background-telemetry-delivery.md)            | Background telemetry delivery            | Accepted |

Use sequential, zero-padded filenames. An ADR records context, the decision,
and its consequences. The status vocabulary is Proposed, Accepted, Rejected,
Deprecated, or Superseded.

ADRs are [living documents](0002-living-decision-records.md). Keep the current
decision in its existing file, including semantic changes after acceptance.
Preserve its number and original date; update `Last updated` and append a dated
change note for substantive revisions. Git history preserves earlier versions.
A new ADR is for a separate decision or a change of scope that needs its own
record, not a mandatory successor for every revision.

All records use [US English](0001-english-project-language.md). Keep context,
decision, and consequences consistent when revising a record, and reconcile
affected documents and references. Accepted still means decided, not deployed.

[RFCs](../rfcs/README.md) own the detailed proposals. If an RFC conflicts with
an accepted ADR, resolve the decision before implementing the conflicting
proposal. Exact limits and API shapes remain proposals until implemented and
verified; this index is not an implementation-status tracker.
