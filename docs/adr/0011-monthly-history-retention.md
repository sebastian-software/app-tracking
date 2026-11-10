# ADR 0011: Separately permitted monthly history

- Status: Accepted
- Activation: Production gates enabled October 28, 2026; see the [October 28 activation receipt](../evidence/2026-10-28-additional-permissions.md)
- Date: 2026-10-28
- Last updated: 2026-11-10

## Context

The private dashboard can inspect only retained 90-day details. Longer product
trends need a finite monthly representation without retaining installation or
repository contribution sets indefinitely. Existing usage grants did not
include longer retention.

## Decision

Retain screened monthly summaries for 24 months after occurrence month end.
Keep the detailed 90-day policy. Require additional affirmative permission,
starting eligibility after server acknowledgement, and separate operator gates
for persistence and public publication. Adopt the fixed screening, whole-month
finalization, unavailable-period, and deletion behavior in the
[monthly-history contract](../monthly-history.md).

No claim of anonymity follows from removing IDs, screening populations, or
rounding counts. Public publication requires the concrete disclosure assessment
and accurate released notices. Both gates are disabled by default; schema deployment
alone does not enable them. The [October 28 activation receipt](../evidence/2026-10-28-additional-permissions.md)
records their production enablement, released notices, and scoped acknowledgements.
It is implementation and release evidence, not legal certification or proof of
consumer rollout.

Coverage starts November 1, 2026. First complete-month history and public receipts
remain tracked by [#13](https://github.com/sebastian-software/app-tracking/issues/13)
and [#14](https://github.com/sebastian-software/app-tracking/issues/14).
They cannot be obtained before December 8, 2026 UTC; screening may still suppress
the eligible month. No earlier usage or ordinary grants are backfilled.

## Consequences

Monthly unique counts cannot be summed into annual uniques. A deletion can make
a whole month unavailable after its source rows expire, because no per-identity
contribution ledger survives the detail window. Recovery invalidates restored
summaries before reporting reopens. The tradeoff preserves bounded attributable
data at the expense of complete long-term series.

## Change history

- 2026-10-28: Select 24 months instead of RFC 0004's five-year proposal; implement
  additional permission and default-disabled persistence/public gates.

- 2026-11-10: Reconcile activation with the October 28 receipt; preserve
  default-disabled gates and the date-blocked first-month evidence.
