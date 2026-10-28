# Monthly usage history

The implementation supports screened monthly summaries for **24 months after
an occurrence month ends**. Detailed usage still expires after 90 days. History
and the public projection are disabled by default; deploying their schema does
not activate them. The selected horizon replaces the five-year proposal in
[RFC 0004](rfcs/0004-historical-usage-summaries.md).

## Additional permission

An existing usage-reporting grant does not include historical retention. The
unified Rust client exposes a separate library-owned
`request_history_opt_in(reason)` dialog, `set_history_opt_in(bool)`,
`history_status()`, and `sync_history_permission()`. These operations neither
grant ordinary reporting nor enable a server feature. No dialog runs in CI,
nonterminal or `Interaction::Never` modes. A saved refusal is reused.

Use the exported `HISTORY_NOTICE` in notice-only settings commands and the same
explanation from the dialog; link the released privacy notice,
and offer the same settings control for withdrawal. The history notice must
explain that screened monthly counts and monthly installation/project totals
can outlive detailed reports, with the 24-month limit. Screening is not a claim
of anonymity. Public publication requires a separate documented disclosure
assessment and operator switch; ordinary usage consent alone permits neither.

Setting a choice is local. Call `sync_history_permission()` only from an
explicit consent/settings command. It has a five-second total network budget,
rejects redirects and mismatched acknowledgements, and leaves failed/offline
choices visibly pending. Register the ordinary identity first. `pending=false`
means the choice was acknowledged, not that a monthly summary exists. The
server accepts only that tool's active reporting credential through
`PUT /v1/history-permissions/events/<installation-id>` (or `legacy` for the old
protocol). Its exact JSON body is:

```json
{
  "schema_version": 1,
  "revision": "monthly-history-v1",
  "enabled": true,
  "changed_at": 1793145600000
}
```

`changed_at` orders choices; it cannot backdate server eligibility. Only usage
from the UTC date after server acknowledgement can participate. Identical
retries preserve this boundary. Older or contradictory choices cannot replace
a newer choice. Expired affirmative requests require a fresh explicit choice;
an old offline withdrawal remains valid. Turning ordinary reporting off also
saves a pending history withdrawal. The host must synchronize it through its
settings command or request ordinary authenticated deletion. Deletion and
identity expiry remove server permission metadata and invalidate summaries.

The optional history state is omitted until used. Older SDKs can read ordinary
unchanged state; a downgrade after using history fails closed on the additional
field. Do not discard state or create a new identity as a downgrade workaround.

## Summary and deletion rules

The [policy JSON](../contracts/history-policy.json) fixes the allowed dimensions.
Legacy and generic streams, local and CI contexts, and each metric remain
separate. Counts measure reported observations. Installation and project counts
are **monthly uniques**; their sum is not an annual unique count or a count of
people. No source identifier set or per-installation contribution ledger is
retained alongside a summary.

Every retained cell requires at least 20 installations and 20 known projects,
with no installation or project contributing more than 10 percent. Unknown
projects form one possible contributor for this test. Each breakdown contains
at most 100 cells. If one cell fails, the whole breakdown is suppressed to avoid
revealing it by subtraction. Only major/minor version families are considered.
These are screening constraints, not proof against coordinated populations,
external information, or differencing across published snapshots.

Finalization starts on day 8 of the following UTC month, after the seven-date
late-arrival window. It recomputes from one retained source snapshot, commits
status and data together, and is idempotent. A missed source deadline, coverage
gap or recovery produces an explicit unavailable period, never a fabricated
zero. A new activation starts at the next full UTC month.

Withdrawal/deletion immediately clears entire potentially affected tool/stream
months. They can be recomputed only while **all** source dates remain. After
source expiry the month remains unavailable. This deliberately trades historical
availability for deletion without a longer-lived contribution map. Logical
expiry occurs at month start plus 25 calendar months, equivalent to 24 months
after month end; scheduled cleanup removes expired rows within 24 hours.

## Read interfaces

The WorkOS-protected `GET /v1/admin/history` accepts `from` and exclusive `until`
as first-of-month UTC dates, at most 24 months, plus fixed `tool`, `stream`,
`metric` and `mode` filters. The private view labels pending, finalized,
suppressed, incomplete, expired and disabled periods independently.

`GET /v1/public/usage` accepts no query parameters. It is 404 while disabled.
When explicitly enabled with [separate publication consent](public-usage-consent.md),
it independently screens the permitted public population and exposes only fixed month/tool/stream/metric/mode
series and observation totals rounded down to multiples of ten. It exposes no
unique counts, command/version/system breakdowns, installation or project IDs,
credentials, or raw rows. Unavailable totals are null. Responses use `no-store`;
consumers must replace an entire current snapshot and preserve gaps, rather
than append old values or turn a missing response into zero.

## Activation and recovery

Keep `APP_TRACKING_HISTORY_ENABLED=0` and
`APP_TRACKING_PUBLIC_USAGE_ENABLED=0` until the released notices, additional
consumer consent flow, and concrete disclosure assessment cover this scope.
`APP_TRACKING_HISTORY_REVIEW_REFERENCE` records that assessment when enabled;
a nonempty string is an audit reference, not automated legal approval. The
public switch requires history to be enabled and a separate publication review.
The schema and tests do not establish legal clearance.

Existing scheduled retention first runs bounded monthly maintenance, then the
90-day cleanup even if summary maintenance fails. A failure must never prolong
detail retention. No counts are printed in deployment/maintenance logs. The
runtime can write only its authenticated permission; the reporting login can
execute fixed read functions and cannot read raw tables or finalize history.

After provider recovery, before reopening reporting, run
`SELECT app_tracking.invalidate_history_recovery_v1()` using the maintenance
login. This disables both switches in storage and clears restored summary
values. Reapply known deletions through the normal flow, reconcile the recovery
gap, then explicitly configure future coverage. Never restore expired source
rows just to backfill history.

The [additional-consent rollout](additional-consent-rollout.md) records the
disclosure boundaries and release checks. Saved history choices carry their
revision; missing/unknown affirmative revisions require a fresh explicit choice.
