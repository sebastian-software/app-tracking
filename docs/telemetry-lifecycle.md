# Deletion, retention, and recovery

Issue [#8](https://github.com/sebastian-software/app-tracking/issues/8) implements
the gated installation DELETE route and scheduled retention work. The
[v1 API](telemetry-api.md) and [retention policy](telemetry-retention.md) own the
public behavior. The production composition gates telemetry separately from version delivery;
[operations](operations.md) owns activation and live readiness evidence.

## Deletion and completion

`DELETE /v1/installations/{uuid7}` needs the installation's bearer credential,
with no body, consent revision, or Content-Type requirement. All responses are
no-store. Unknown records return `404`; wrong credentials return `401`.
Correct credentials remain useful after revocation or inactivity expiry.

The database locks the same installation row used by registration and ingestion.
Its first committed deletion step clears consent/context/activity and upload-rate
state, marks authority revoked, and removes the installation from reporting
visibility. An already inactive installation keeps its original expiry time.
Uploads and registration cannot restore that authority.

A step removes at most 1,000 usage rows, 1,000 receipts without remaining usage,
and 1,000 quota rows. Receipt deletion never cascades an unbounded contribution
set. The database returns completion only when no primary contribution, receipt,
or quota remains. Only that outcome becomes an empty HTTP `204`.

A larger installation may need several steps. A committed partial purge returns
`503 service_unavailable` with `Retry-After: 60`; the client keeps deletion
pending and retries the same credential/ID. The scheduled worker can finish the
same purge between attempts. A failed/aborted call is also an unknown outcome;
never interpret it as completion. A physical-purge lock/statement timeout rolls
back that page while preserving the authenticated revocation and pending marker;
no contribution becomes visible again because physical cleanup was blocked. No new public status endpoint or asynchronous
success acknowledgement is added. Repeated completed deletion does not renew
the tombstone time.

The minimal tombstone retains tool, ID, credential hash, state, original transition
time, and the purge-pending flag. It contains no consent/context, usage counters,
or project identity. It expires after ninety days. Its old UUID cannot satisfy
first-registration time validation after garbage collection.

## Reporting and invalidation boundary

`app_tracking.reporting_usage_v1` is the authoritative visibility view for future
reporting: it joins only active, nonexpired installations and excludes usage at
the exact ninety-day UTC cutoff. Inactivity uses 2,160 elapsed hours, so a
reader's session timezone or a daylight-saving transition cannot extend visibility. A committed revocation disappears from a new
query even while a large physical purge is pending. One installation's deletion
never removes another installation's contributions to the same project.

No durable rollup or usage cache exists in v1. Future reporting roles/routes must
use this view, receive no bypass through base-table reads, and serve no-store
responses. Future rollups/caches need explicit deletion/expiry invalidation in
#13/#14; they cannot claim correctness by reading the raw tables or summing a
previously cached result. Runtime/reporting credentials currently have no SELECT
access to either the view or the underlying tables.

## Scheduled maintenance

The `Telemetry retention` workflow runs hourly at minute 17 UTC and can be
invoked manually after merge. It authenticates to the database with the existing
encrypted `APP_TRACKING_MIGRATION_DATABASE_URL` Actions secret and calls only
the fixed maintenance command. It needs no Bunny secret, HTTP maintenance
endpoint, additional database credential, or permanent service.

```sh
# Supply the database credential through the execution environment.
node scripts/storage/run-retention.ts
```

Each transaction has a 2.5-second statement deadline, takes a nonblocking worker
lock, locks one eligible installation, and removes bounded slices. Inactivity
expiry is recorded at the original last-activity-plus-ninety-days boundary.
Cleanup removes expired usage, expired receipts and their remaining contributions,
no-longer-needed daily quotas, idle upload-attempt timestamps, and completed old
tombstones. Logical authority/visibility checks do not wait for this worker.

`purge_pending` and the remaining eligible rows are durable progress markers.
A stopped runner resumes from committed work without an external cursor, queue,
or process memory. The default runner budget is at most 1,000 transactions of
1,000 rows per table. Invalid limits, contention, SQL failure, or an exhausted
budget fail the workflow; they never print successful completion.

`maintenance_state` holds only the latest committed attempt/progress/completion
timestamps, with no identifiers or event history. Public Actions logs contain
only static completion/failure status; actual cleanup counts remain private and
are not published as analytics. The runner uses aggregate counters in memory. A failed workflow is an immediate failure signal; #11
must monitor last-completion age and establish the operational alert owner.
GitHub cron is not an exact execution-time guarantee. Missing the twenty-four-hour
physical-cleanup bound is an operational failure to investigate and rerun, not a
reason to include logically expired data in reports.

## Ordinary recovery

Use normal PlanetScale backup/PITR to restore one consistent dataset. Do not
append a snapshot's counts, merge multiple recovery points, invent fresh batch
IDs for acknowledged reports, or add a separate deletion-history store.
Restoring an older point also restores authority/data deleted after that point.
That is the documented recovery boundary, not a stronger historical-erasure
claim. Handle known deletion requests through the normal DELETE operation after
recovery and report the recovery-point gap in coverage.

The automated recovery proof uses PostgreSQL 18.6 in an isolated local/CI
container. It dumps only synthetic test data into memory, deletes the source
installation, and restores into a separate logical test database. It verifies
that the later deletion rolls back in the restored copy, the restored receipt
prevents a second contribution, expiry filtering applies immediately, and a
normal repeated deletion/maintenance clears the restored contributions.
Snapshot bytes never become public logs, files, or artifacts. This is not a
PlanetScale restore or a reason to roll back the shared provider cluster.

## Evidence

The local suite passed 26 storage, 72 ingestion, 73 deletion/retention, and 11
isolated recovery checks. A 32,768-row fixture required 33 deletion calls;
the one-row-per-batch variant also exercises the receipt page limit; its largest
observed local handler-plus-TCP-call duration was 229.20 ms.
This is a page-work sample, not an end-to-end maximum data-size or capacity
benchmark. Each page remains bounded independently of total installation size.
[PlanetScale run 40311044070](https://github.com/sebastian-software/app-tracking/actions/runs/40311044070)
passed 78 ingestion and 73 deletion/retention checks with the real HTTP driver.
The 32,768-row, 32,768-receipt fixture required 33 deletion calls; maximum
observed handler-plus-driver duration from Actions was 489.68 ms. The fixed
maintenance command also completed. These are Node handler/driver observations,
not a deployment or latency measurement of a public Bunny deletion route.

An earlier live run stopped at initial registration before useful status
instrumentation. Its cause was not established; the subsequent diagnostic and
full-receipt runs passed. This is not an availability guarantee. Client retry
semantics and the operational monitoring in #11 remain required.

The synthetic volume loader runs PostgreSQL `ANALYZE` after bulk insertion.
A controlled cold-statistics fixture without it exhausted the 2.5-second SQL
budget. The corrected DELETE preserved revocation and zero reporting visibility;
a subsequent analyzed page completed quickly. Row-count limits bound writes,
not optimizer cost under arbitrary stale statistics. Normal database statistics,
statement/lock deadlines, and maintenance-failure monitoring remain operational
requirements. A separate deterministic test holds a usage-row lock, verifies
pending revocation survives, releases it, and then observes completed deletion.
