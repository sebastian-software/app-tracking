# ADR 0011: Separately permitted monthly history

- Status: Accepted
- Activation: Pending disclosure review
- Date: 2026-10-28
- Last updated: 2026-10-28

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
and accurate released notices. Deployment leaves both new gates disabled.

## Consequences

Monthly unique counts cannot be summed into annual uniques. A deletion can make
a whole month unavailable after its source rows expire, because no per-identity
contribution ledger survives the detail window. Recovery invalidates restored
summaries before reporting reopens. The tradeoff preserves bounded attributable
data at the expense of complete long-term series.

## Change notes

- 2026-10-28: Select 24 months instead of RFC 0004's five-year proposal; implement
  additional permission and default-disabled persistence/public gates.
