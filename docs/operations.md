# Production telemetry operations

Palamedes v2 is the first opt-in telemetry consumer. The public service uses one
Bunny Edge Script and Pull Zone with a separate PlanetScale runtime credential.
Version checks do not depend on the database or telemetry consent. Admin queries
and public exports remain closed (#13/#14). Proof of work is deferred (#31).

## Activation and evidence

Technical proof can run before public activation:

```sh
gh workflow run deploy.yml --ref BRANCH -f production_proof=true
```

This publishes the same service composition and HTTP database driver to a
short-lived, authenticated Bunny endpoint. It tests versions/cache policy,
registration, ingestion/replay/rejection, scoped deletion, retention, and
anonymous telemetry access denial. Public version/health data remains public,
including CDN cache hits. Its encrypted runtime/test secrets and linked Pull
Zone are removed afterward. It uses owned synthetic reports only; it is not a
permanent staging environment or evidence that the public consumer is enabled.
The `ingestion_test` input remains the broader real-database concurrency suite.

Before setting the repository Actions variable
`APP_TRACKING_TELEMETRY_ENABLED=1`, verify:

- The controller/contact, optional current consent, purposes, fields, project
  hash guessability, rights, processors, transfers, and retention match the
  [notice](telemetry-consent.md). Check existing processor agreements; any new
  agreement must be completed by the account holder. Do not infer completion
  from having an account or a provider's public GDPR page.
- The PlanetScale cluster remains in AWS Frankfurt, backups expire within the
  seven-day policy, no protected/manual copy extends that window, and ordinary
  backup/PITR remains the recovery method. Review future backup changes too.
- Query/slow-query/sample logging is disabled for the runtime and error bind
  parameter logging is zero. The deployment checks these effective settings.
  Query Insights must not preserve unredacted report parameters. Do not add a
  collector, `auto_explain`, statement logging, or external forwarding without
  checking its disclosure and access/retention implications.
- Pull Zone access logging, permanent log storage, forwarding, and error cache
  remain disabled. The application logs no reports, credentials, identifiers,
  URLs, SQL, or provider exceptions. Internal security/transport processing is
  separate: record the applicable agreement, published product limits, and unknown
  internal periods as described in the [provider-record disclosure](telemetry-retention.md#provider-owned-operational-records).
  Disabled CDN logging does not establish their retention. Do not promise an
  unverified universal cap or enable an extra logging product.
- Only the app-specific runtime credential enters the encrypted Edge Script
  secret. It has no schema/table/admin/maintenance privileges. Migration and
  maintenance authority stays in encrypted repository Actions secrets.

The existing database proof established the app-specific logical database,
unprivileged runtime role, and transaction boundaries. Check current settings
again at activation; evidence can become stale. This runbook is not a legal
certification, a statement that an agreement was signed, or proof of EU-only
processing. Bunny serves globally and PlanetScale's EU database region alone
does not determine the whole processing chain. Provider sources:
[Bunny GDPR/DPA](https://bunny.net/gdpr/),
[Bunny subprocessors](https://bunny.net/gdpr/sub-processors/),
[PlanetScale DPA](https://planetscale.com/legal/data-processing-addendum), and
[PlanetScale backups](https://planetscale.com/docs/postgres/backups).

Deploy main using `deploy.yml`. The workflow verifies effective permissions and
logging before writing runtime secrets and publishing. Failed checks do not
justify weakening the contract or claiming readiness. Run the consumer's
`node scripts/check-app-tracking-ready.mjs` after deployment; it checks public
version and uncached telemetry availability without credentials or reports.
Keep the existing Palamedes publication hold separate from this service change.

## Signals and response

The hourly `Telemetry operations` workflow reports bounded synthetic pass/fail
signals for registration, acceptance, identical replay, conflicting replay,
credential rejection, deletion, cache bypass, database access, last successful
retention, and old pending deletions. They contain no ID-bearing labels and are
not usage counters or adoption measurements. It creates one owned CI fixture,
deletes its contributions, and never reads real reporting rows for publication.
`Telemetry retention` remains hourly and reports only completion. No additional
operational telemetry dataset is stored; GitHub's workflow history contains only
synthetic checks, not the seven-day operational-counter dataset allowed by the
contract. Actual usage queries and their authorization remain #13.

Repository maintainers own the workflows, failure notifications, and recovery.
Enable GitHub Actions notifications for these workflows in the maintainer's
account. No external alert destination is configured by this repository.

| Signal                                              | Action threshold                                               | Response                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registration/acceptance/replay/cache/deletion probe | Any failed run                                                 | Inspect revision and fixed check category; retry once after provider recovery. Keep fixture cleanup authority private if deletion is still pending.                            |
| Retention                                           | Last completion older than three hours                         | Run retention; resolve credential/provider/budget failure before the 24-hour physical cleanup bound.                                                                           |
| Deletion backlog                                    | Any purge pending over one hour                                | Run retention and inspect bounded deletion progress privately; never claim a 204 for unfinished work.                                                                          |
| Suspected registration abuse                        | Provider limit hits, cost increase, or repeated probe failures | Keep upload/deletion policy intact, lower gateway limits if appropriate, or disable telemetry while preserving version delivery. Limits are not authentic-client verification. |
| Database unavailable                                | Any operations failure                                         | Preserve immutable retries; no direct upstream or unbounded retry fallback. Check the independent version route.                                                               |

No public dashboard or request-level counter is introduced here. Synthetic
signals do not prove every region, peak capacity, absence of abuse, or loss-free
delivery. Hourly GitHub schedules can be delayed; workflow failure notification
and retention completion time are the current monitoring boundary.

## Disable, rollback, and recovery

Set `APP_TRACKING_TELEMETRY_ENABLED=0` in Actions variables and redeploy main to
close telemetry routes. The version API stays available; clients retain their
bounded queue and back off. Reopening requires the same checked configuration.

For a faulty bundle, use `release_run=RUN_ID` from a successful main deployment.
The retained immutable artifact, manifest hash, revision, activation state, cache
purge, and live checks are verified. A prior version-only artifact closes
telemetry without changing the additive schema. Restore main with a normal
deployment after the rollback proof. Do not use an unverified or expired
artifact or reverse database migrations.

Ordinary PlanetScale backup/PITR remains available for actual database recovery.
A restore can roll back post-recovery-point revocations; follow the documented
[recovery boundary](telemetry-retention.md#ordinary-provider-recovery), apply
current expiry, and handle known deletion requests normally. Do not merge
snapshots, replay acknowledged reports under new IDs, purge unrelated data, or
introduce a deletion-history service.

Keep public evidence limited to revision, pass/fail, bounded fixture/check
counts, and cache state. Never commit account/resource IDs, private hosts,
credentials, operator details, provider support material, or real usage.
