# RFC 0003: Deployment, migration, and validation

- Status: Proposed
- Date: 2026-10-22
- Constraints: [ADR 0001](../adr/0001-independent-service-and-gradual-adoption.md),
  [ADR 0004](../adr/0004-bunny-hosting-and-planetscale-storage.md)

## Starting point and evidence

I propose a new Bunny Edge Scripting deployment for app-tracking with a
PlanetScale Postgres database. Existing services continue to serve their own
consumers during migration. No repository merge, old-host takeover, or legacy
adapter is required for this design.

Public source and documentation inspected on 2026-10-22 establish useful
reference points:

- [version-service](https://github.com/sebastian-software/version-service/tree/005f86a3245afb4d344b23dceb73ceaad6f1871a)
  has a strict six-field `POST /check`, an npm version lookup, a ten-minute
  in-process cache, and Rybbit forwarding. Successful responses depend on
  analytics acknowledgement and carry `Cache-Control: no-store`.
- [oss-metrics](https://github.com/sebastian-software/oss-metrics/tree/3333a430432f064516409a4bcb6b39aea48cb675)
  has a public CDN-cached snapshot and repeatable Bunny provisioning. Its
  broad statistics collection is unsuitable as a dependency of a fast CLI
  version request. Its broad route caching must not be copied onto private APIs.
- [version-service issue 12](https://github.com/sebastian-software/version-service/issues/12)
  records a deployed service and enabled Palamedes releases, with a remaining
  published-client observation task. The existing service cannot be assumed
  unused merely because that evidence task remains open.

These are repository observations and documented deployment evidence, not an
independent inspection of current production configuration. Private runtime
details and real analytics are intentionally absent from this repository.

## Candidate runtime

Keep the service modular within one deployable TypeScript edge bundle:

- HTTP routing and strict request validation.
- Reviewed tool/distribution catalog and release resolver.
- Installation authority and usage ingestion.
- Bounded aggregate queries and maintenance operations.

PlanetScale's current
[Neon-driver documentation](https://planetscale.com/docs/postgres/connecting/neon-serverless-driver)
supports Postgres over HTTP using its SQL endpoint, including non-interactive
transactions. This supersedes the older assumption that only the WebSocket
mode is supported. Pin and test the actual driver version; documentation is
evidence of a candidate contract, not a successful Bunny integration test.

Use the [RFC 0001](0001-service-api-and-data-model.md) database function or an
equally proven transaction boundary for ingestion. Do not require persistent
connections or an in-memory edge instance to preserve reporting correctness.

The published [Bunny limits](https://bunny.net/docs/scripting/limits) include
50 subrequests and 128 MB active memory. Batch SQL work rather than issuing one
HTTP database call per usage row. Measure cold starts, request latency, memory,
and subrequests with representative maximum-size batches. Do not infer safe
capacity from these limits alone.

## Provisioning and deployment

Create independent test and production deployments with separate database
credentials, data, hosts, and synthetic verification traffic. Hostnames are
not selected by this RFC; use reserved example domains in documentation.

Version the non-secret desired infrastructure state and implement idempotent
provisioning. Keep account credentials and runtime database credentials in the
chosen secret stores, with the narrowest supported scopes. Deployment and
schema-migration credentials are not runtime client credentials and never enter
the public bundle or CLI.

The proposed pipeline is:

1. Validate documentation, types, unit tests, and contract tests; build one
   identifiable bundle from a recorded commit.
2. Apply additive database migrations in the test environment.
3. Deploy the same bundle to test and run cache, transaction, deletion, privacy,
   and consumer checks with synthetic data.
4. Apply compatible production migrations and publish through a protected,
   explicitly authorized production workflow.
5. Verify release identity, endpoint behavior, and operational signals. Keep a
   previous compatible bundle for rollback.

No deployment workflow or infrastructure is created by the documentation
bootstrap. Exact commands, runtime versions, secret names, and production
authorization mechanics belong in implementation and its runbook once verified.

## CDN and regional behavior

Cache only explicitly public version and approved aggregate GET responses.
Keep registration, reports, deletion, health, and admin routes out of shared
caches regardless of method or authorization headers. Query parameters must
not bypass validation or be ignored where they change response semantics.

Bunny's [Cache API](https://bunny.net/docs/scripting/cache) is regional and
subject to Pull Zone settings. It is not a durable global deduplication store.
Explicitly test cold and warm delivery, freshness, ETags, purge behavior,
eviction, and a database/registry outage. A successful cache write alone does
not prove a later request will reach the same cached entry.

Prefer EU processing for telemetry and an EU database region. Bunny's
[routing filters](https://bunny.net/docs/cdn/performance/routing-filters)
apply to CDN Pull Zone traffic, not every platform operation. Verify the actual
script, database, backup, support, and processor configuration before making
residency claims. Public version delivery and private data processing have
different sensitivity, but they still need documented routing and logs.

## Privacy and access in operation

Disable raw request logging for service routes and prevent payloads, identifiers,
credentials, authorization headers, and SQL parameter values from leaking into
application logs, error monitoring, query diagnostics, or CI artifacts.

Bunny's [logging documentation](https://bunny.net/docs/cdn/logging) states that
IP anonymization applies on read at the API boundary. That setting alone does
not prove that full IP addresses were never retained. Verify provider-internal
logging and retention separately, together with processor agreements and any
relevant transfers. Do not promise zero transport metadata processing.

Public source makes the design inspectable. It does not prove that the deployed
revision, logging settings, retention jobs, or consent behavior match the source.
Record sanitized operational evidence without publishing live credentials,
internal hostnames, provider account IDs, operator identities, or real reports.

Reporting credentials authorize only one installation's reports and deletion.
They do not authenticate a person or prevent fabricated usage. Define payload
limits, bounded request rates, registration limits, and an abuse response before
launch. Avoid permanent IP-derived identity as a measurement or deduplication
mechanism. Admin access requires separately reviewed maintainer authorization.

## Maintenance, observability, and recovery

Start with bounded maintenance work invoked by a scheduled GitHub Actions job
against an authenticated service operation. Retention cleanup must not depend
on public user traffic. Long cleanup passes need resumable chunks and a durable
progress marker; a timed-out run cannot silently count as completed.

The initial operator signals are version freshness and failures, report
acceptance/replay/rejection totals, database latency/errors, and age of the last
successful retention run. Keep labels bounded and exclude installation and
project IDs. Alert thresholds and operating ownership are open until an
operator and workload are established.

Document backup retention, restoration, deletion replay, and rollback before
production. A restored backup must not resurrect withdrawn reporting authority
or deleted usage. Exercise restoration in isolation; a successful backup job
does not prove recovery. Prefer compatible schema changes because rolling back
the application bundle does not reverse already committed data.

Estimate cost from the selected database tier, region, backups, edge requests,
CPU, and transfer. There is no justified traffic forecast or final monthly
budget yet. Published minimum prices are not a service cost estimate.

## Delivery sequence and acceptance

The [implementation tracker](https://github.com/sebastian-software/app-tracking/issues/17)
breaks these outcomes into issues with explicit prerequisites. Start with the
[version endpoint](https://github.com/sebastian-software/app-tracking/issues/1).
The shared update client and Dalo's version-only migration can ship before
telemetry is ready.

| Package | Observable outcome | Evidence required |
| --- | --- | --- |
| Version service | One reviewed release resolver answers a compact GET independently of telemetry | Cold/warm cache checks, distribution eligibility, stale/outage cases, no reporting identifiers |
| Shared update client and Dalo version checks | A published consumer uses the new version contract without telemetry | Local comparison, disable/offline controls, concurrent check state, installation guidance, output/latency, staging delivery |
| Consented ingestion | Registered installations can submit immutable batches safely | Real database concurrency, duplicate/reused IDs, lost acknowledgement, expiry, withdrawal and deletion races |
| Shared telemetry client and Dalo opt-in | One consumer adopts reporting without altering command semantics | Consent/no-consent, URL normalization, concurrent local state, offline behavior, JSON/output/latency, wrapper deduplication |
| Private and public reporting | Maintainers can inspect useful aggregates and approve a bounded public export | Distinct counts across periods, missing coverage, unknown-project usage, deletion propagation, no row-level public data |
| Palamedes and later tools | Each consumer deliberately replaces its old path | Consumer-specific release, consent, opt-out, output, packaging, and end-to-end evidence |

Telemetry ingestion and client integration depend on an agreed contract and
the database/runtime proof, not on completion of unrelated dashboard styling.
A production telemetry consumer must wait for the service and its
privacy/operations gates. Version-only delivery does not require that database
or telemetry enablement. The exact test commands will come from the
implementation; the existing reference projects' checks are not proof that
app-tracking works.

## Coexistence and retirement

The initial plan leaves `version-service` and `oss-metrics` unchanged. Existing
published clients continue to use their original endpoints. The new service
does not implement their contracts or take over their hostnames.

A migrated client version uses app-tracking only for its update/reporting
mechanism. It does not send a second legacy usage event for the same invocation.
Old opt-out settings remain effective, and old automatic reporting does not
become consent to new identifiers or command counts.

Keep historical update-check counts separate from new usage measures. Later,
`oss-metrics` can consume a deliberately limited aggregate export with units,
time windows, freshness, and coverage. That is a consumer migration, not a
database credential handed to a public website.

Retiring an old endpoint requires a separate decision supported by consumer
release/adoption evidence and an explicit support policy. The absence of
telemetry does not prove that old clients are unused. Do not automatically
disable an existing service as a side effect of deploying this one.

## Decisions still needed before rollout

- Runtime/driver proof, database region/tier, hostname, and license.
- Final consent wording, installation identity scope, retry bounds, retention,
  backup/deletion policy, and stale-version limit.
- Maintainer authentication, public aggregate disclosure, and abuse controls.
- Short-lived client upload strategy and measured latency/size budgets.
- Production operating ownership, deployment authorization, recovery evidence,
  and the first consumer's release gates.
