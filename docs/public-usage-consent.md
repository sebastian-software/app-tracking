# Optional publication of monthly usage totals

`public-usage-v1` is a third, independent purpose. Ordinary reporting, private
monthly history, and profile linking never authorize it. A publication grant
requires ordinary reporting and monthly-history grants, each given separately.
Refusing publication leaves both private purposes available. Dalo and Ferriki
consumer adoption remains deferred.

## Disclosure assessment: October 28, 2026

Purpose: let users understand adoption of the participating tools. Recipients:
anyone using the public app-tracking endpoint or its oss-metrics adapter. The
published unit is reported observations, not people or all installations.

The public population is built independently from reports with an affirmative
publication permission. It never reuses the private history total. Eligibility
is the later of the two server-assigned history/publication boundaries, from
the UTC date after acknowledgement. A backdated client choice cannot include
old reports. Public coverage begins at the next full UTC month after operator
enablement. There is no backfill when publication is enabled later than history.

Each month/tool/stream/metric/local-or-CI group must have at least 20 reporting
installations and 20 known repositories, and no installation or repository may
contribute more than 10 percent. Unknown repositories are treated as one possible
contributor. Counts are rounded down to tens. Only that rounded total is retained
in the public summary table for 24 months after month end. Identifiers, unique
counts, and command/version/system breakdowns never enter it. The endpoint offers
no arbitrary date/dimension filters. Profile linking is independent and profile
overlap is never published.

These controls reduce disclosure; they do not prove anonymity. Random identities
can be copied or fabricated, repository hashes are guessable, populations can be
coordinated, and someone with external knowledge can compare successive releases.
Rounding is not differential privacy. Suppression can itself reveal that a group
no longer qualifies. The notice therefore seeks specific publication consent and
explains these limits instead of treating a threshold as an anonymization claim.
No private total or public unique count is exposed as a complementary cell.

Acknowledged withdrawal clears entire potentially affected public months under
the same finalization lock. Private history remains available if still permitted.
Recomputation is allowed only while every source date remains. A smaller cohort
must pass screening again; otherwise the response is unavailable, never zero.
History withdrawal also revokes publication; re-enabling history does not restore
that choice. Ordinary deletion/expiry invalidates both summaries. Recovery clears
both, disables the gates, and requires future coverage reconciliation.

Anyone can copy previously published figures. The service and oss-metrics use
`no-store` and replace current snapshots without a stale fallback, but cannot
recall external copies. The consent notice explicitly states this limitation.
Users can decline publication without losing the tool, updates, ordinary reporting,
or private monthly summaries. This is an implementation/disclosure assessment,
not a legal opinion, certification, or claim of anonymous data.

## Controls and API

The SDK exports `PUBLIC_USAGE_NOTICE`, `PUBLIC_USAGE_CONSENT_REVISION`,
`request_public_usage_opt_in(reason)`, `set_public_usage_opt_in(bool)`,
`public_usage_status()`, and `sync_public_usage_permission()`. The library dialog
and host notice-only settings use identical disclosures. Ordinary commands do not
prompt, synchronize these choices, or infer grants from files or environment flags.

`PUT /v1/public-permissions/events/<installation-id>` uses the ordinary tool-scoped
bearer credential and `App-Tracking-Tool`. The exact body is
`{schema_version:1,revision:"public-usage-v1",enabled,changed_at}`. It has the same
bounded transport, monotonic ordering, exact acknowledgement, offline pending
state, and future-only server eligibility as history permission. The runtime and
storage operator gates must both permit a positive grant. Withdrawal remains
available with publication disabled.

The fixed public response contract remains unchanged, so oss-metrics consumes
only current screened totals without credentials, storage, or cached fallback.
The new SQL function and tables are inaccessible to runtime/reporting logins;
only the runtime's authenticated fixed setter and reporter's fixed read are granted.

## Validation and activation

Storage fixtures verify operator-on/history-only suppression, backdated grants,
wrong credentials, exact public-only persistence, group thresholds, independent
withdrawal, stale grants, source expiry, deletion, recovery, and privilege limits.
SDK/HTTP fixtures cover separate revisions, prerequisites, exact acknowledgements,
offline choices, and automatic publication withdrawal with private-history withdrawal.

The official English/German notice must expose `/privacy#tool-usage-public` before
enabling the operator gate. Publish and verify the SDK artifact, then adopt its
exact version in Palamedes. Record this document and the released notice/consumer
references in the activation evidence. Enabling the endpoint initially returns an
empty series; the first eligible completed month can be finalized only after its
seven-date late-arrival window and only if its public cohort passes screening.
