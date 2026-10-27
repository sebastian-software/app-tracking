# RFC 0004: Historical usage summaries

- Status: Proposed; no historical persistence or retention change enabled
- Date: 2026-10-27
- Related issue: #13

## Purpose and boundary

Preserve useful invocation, command, and version trends after the exact rolling
90-day attributable window expires. The implemented
[private reporting API](../reporting.md) deliberately recomputes retained data;
it cannot reconstruct expired history. The existing policy stays effective
until a replacement is implemented and its disclosure is reconciled.

Proposed default for review: retain finalized monthly summaries for five years
after the end of their occurrence month, with daily granularity available only
inside the existing detail window. Five years is a product proposal, not a
statutory deadline or an approved anonymity claim. The intended historical
audience is maintainers; public release remains #14. We need an explicit choice
of historical horizon and a disclosure-risk review before enabling persistence.

## Candidate output

Use fixed, separate monthly series for tool/context totals, tool/context/command
invocations, and tool/context/version-family invocation share. Do not expose
arbitrary intersections of command, version, project, and installation. Collapse
rare versions into a reviewed broader family or suppress them; exact prerelease
or unusual patch versions may identify a very small cohort.

Monthly active-installation and active-project counts are candidates too, not
identifiers or sets retained after expiry. Compute them over the whole month,
with `(tool, installation)` and cross-tool versioned project identities matching
the detail API. Label them **monthly uniques**. Summing them never gives annual
uniques; do not provide an annual-unique figure without a separate design.
No long-lived identifier sets, per-project summaries, sketches, or repository
dictionary are proposed.

Start disclosure review with cohort support and contribution concentration,
not just removal of ID columns. A candidate minimum of 20 installations and
20 known projects per released cell is only a screening rule. Unknown-context
contributions and a single installation/project dominating a cell can still
make it attributable. Review concentration limits, small tool populations,
rare versions, relationships between totals and breakdowns, and differences
between months. Suppress complementary cells or whole breakdowns when totals
would reveal a suppressed value by subtraction. Do not retain hidden fine cells
behind a coarser display and call them anonymous. These tests alone do not prove
anonymity; publish no such assertion without the concrete risk assessment.

## Finalization before source expiry

Run a scheduled finalizer after the client's seven-date late-arrival window
has closed for a complete UTC month. For month M, M+1 day 8 at UTC midnight is
a conservative earliest finalization point. This is well before the first day
of M reaches its exact 90-day expiry. A calendar month is not 90 days.

The job must recompute, never increment, from one authoritative snapshot.
Use a transaction and unique `(summary revision, month)` record to make retries
idempotent, plus a fixed dimension key for each accepted cell. Commit an explicit
period status and output together: pending, finalized, suppressed, or incomplete.
Record the detail policy/version and finalization time without source IDs. No
request-driven query may silently finalize a missing historical month.

Track successful scheduling from a known coverage start. Reject finalization
if any source dates have already expired or a known recovery gap invalidates
coverage. Alert before the earliest month date expires. If a job misses that
deadline, record **incomplete**, not zero or a partial value labeled complete.
Do not restore reporting data from backups solely to fill history. Existing
ordinary recovery does not append snapshot counts; it must invalidate/review
any affected finalization status too.

## Deletion and remaining review

Before genuine anonymization, these remain attributable derived data. Revoke
visibility immediately on deletion and recompute affected summaries while their
sources exist. Anything requiring a retained source-to-summary contribution
map after 90 days extends pseudonymous history and needs its own justified
purpose, finite retention, deletion path, and accurate consent disclosure. Do
not smuggle such a map into a summary implementation.

If an approved process actually produces anonymous final summaries, retaining
them after source deletion may be possible, but that conclusion depends on the
assessment above. If the assessment fails, either suppress the month/cell or
choose an explicitly disclosed attributable-history design. Hashes, coarse
dates, a private dashboard, and thresholding are not enough by themselves.

Implementation acceptance must include small/coordinated cohorts, dominance,
complementary suppression and cross-query attacks, retries, delayed arrival,
deletion before/after finalization, exact UTC expiry, a missed finalizer,
recovery, and historical expiry. Update the policy JSON, retained-data notice,
SQL lifecycle, bounded worker, private API, view, and operations evidence
together before enabling this feature. Current data stays available through
the private 90-day view while these decisions are reviewed.
