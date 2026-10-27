# Maintainer usage reporting

The private `/admin` view and `GET /v1/admin/usage` show consented CLI usage.
They use a separate read-only maintainer key and database login. CLI reporting
credentials grant no access. Reporting is disabled by default and is independent
of version delivery and telemetry ingestion.

## Query contract

Request `/v1/admin/usage?from=2026-10-01&until=2026-10-28&tool=all&mode=local`
with `Authorization: Bearer MAINTAINER_KEY`. Do not put the key in a URL,
shell history, exported report, screenshot, or issue. The view accepts it in a
password field and holds it only in tab memory. Reloading or signing out clears
access. It uses no cookies or browser storage. The public HTML shell contains
no usage data or key; the API requires authentication for every query.

| Parameter | Meaning                                              |
| --------- | ---------------------------------------------------- |
| `from`    | Inclusive UTC occurrence date, `YYYY-MM-DD`          |
| `until`   | Exclusive UTC occurrence date, at most tomorrow      |
| `tool`    | `all` (default), `dalo`, or `palamedes`              |
| `mode`    | `local` (default) or `ci`; never combined implicitly |

The requested window must span 1–90 dates. Unknown/duplicate parameters,
invalid calendar dates, and future end dates return 400. The view's **Through**
field is inclusive and converts to the exclusive API boundary. It offers 7-,
30-, and 90-day presets and custom dates. There are no arbitrary SQL,
properties, groupings, identifiers, or row-export routes.

Every success has `schema_version: 1`, the requested `scope`, a `period`,
`coverage`, `totals`, `daily`, `commands`, and `versions`. Counts are unsigned
decimal **strings**, so large SQL totals do not lose JavaScript precision.
The view formats them with `BigInt`. Period metadata includes the requested
`from`/`until`, actual `covered_from`, and a UTC `snapshot_at`.

| Measure                       | Unit and scope                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `invocations`                 | Sum of accepted command counts, not requests or people                                                                      |
| `active_installations`        | Distinct `(tool, installation)` over the entire selected window                                                             |
| `active_projects`             | Distinct `(project identity version, project hash)` over that window, shared across tools and clones; forks remain distinct |
| `unknown_project_invocations` | Invocation counts without a known project; no invented project identity                                                     |

`daily` supplies the same invocation/unique measures per occurrence date,
including zero dates in the covered window. Do not sum daily uniques to get
period uniques. `commands` groups invocations by tool/command. `versions`
groups by tool/version and returns the top 100 by invocation count, with stable
tie-breaking; `versions_truncated` signals omission. Totals include omitted
versions. Version adoption measures invocation share, not installed copies.
Unknown-project percentage divides unknown invocations by total invocations;
the view shows no percentage when there are no invocations.

## Coverage, changes, and failures

Only active, unexpired reporting installations and unexpired usage participate.
At UTC date T, the earliest retained occurrence date is T−89. Earlier dates
are clipped explicitly: `coverage.clipped=true`, `retained_from` and
`covered_from` show the boundary. A wholly expired window returns 422 with
`error: outside_retention` and `retained_from`, rather than successful zero.

An empty covered window returns zero counts and `has_observations=false`.
That means no currently visible reports, not proof of no tool use or perfect
delivery. Participation is voluntary and biased toward consenting installations.
CI requires its separate opt-in. Unknown context, offline queues, rejected or
lost batches, and client vetoes limit coverage. The view states these units and
participation limits instead of extrapolating to all users.

Reports use occurrence dates rather than receipt dates. The recent seven UTC
dates are provisional (`provisional_from`); today is also partial. Older counts
can still decrease through deletion or expiry. Every query uses one database
statement snapshot. Revocation committed before that snapshot removes the
installation's contributions even while physical deletion is pending. A query
already in progress can reflect its earlier snapshot; refresh to observe the
new state. There is no aggregate cache or materialized copy to invalidate.

401 means missing/invalid maintainer authority. Cross-origin browser requests
are rejected with 403; no CORS access is granted. Dependency, timeout, or invalid
database result failures return a redacted 503. Errors and successes use
`Cache-Control: private, no-store`, `CDN-Cache-Control: no-store`, and
`Surrogate-Control: no-store`. The view clears previous figures before querying
and distinguishes failures, empty observations, and expired periods.

## Enable on the existing Bunny service

1. Create a **separate** app-specific PlanetScale PostgreSQL login. Do not reuse
   the ingestion, owner, migration, or maintenance login. It must have no role
   memberships or broad privileges. Set its `statement_timeout` to `2500ms`
   and `lock_timeout` to `1500ms`; allow database connection. Keep the same
   effective query/parameter logging restrictions as the runtime login.
2. Generate a new 256-bit maintainer key into a new private file **outside the
   checkout**: `node scripts/create-reporting-key.ts /PRIVATE/PATH/reporting-key.json`.
   The helper refuses overwrite, uses mode 0600, and prints neither key nor hash.
   Store the plaintext key in the maintainer's private credential store. It
   grants read access to all supported tool/context aggregates, including small
   groups; it is not a public-share credential or anonymous dataset.
3. Put the reporting connection URL in encrypted repository Actions secret
   `APP_TRACKING_REPORTING_DATABASE_URL`. Put only the generated `token_sha256`
   in encrypted secret `APP_TRACKING_ADMIN_TOKEN_HASHES`. The digest includes
   the `app-tracking-admin-v1` domain separator; do not substitute a plain
   SHA-256 of the token. Up to eight comma-separated digests support rotation.
4. Set Actions variable `APP_TRACKING_REPORTING_ENABLED=1` and deploy main.
   Deployment applies additive migration 0007, verifies the login has no table
   or ingestion authority, grants only schema usage and
   `admin_usage_v1(date,date,text,text)` execution, checks effective logging,
   and writes the separate encrypted Bunny secrets. The ingestion role cannot
   execute the reporting function. Configuration failure stops deployment.
5. Verify `/admin` loads without private data, an unauthenticated usage request
   returns 401 with no-store headers, and repeated requests are not CDN hits.
   The deployment verifier performs these public checks without any key. Then
   privately open the view with a maintainer key and verify a bounded query.
   Never publish a screenshot or fixture copied from real usage as evidence.

The new secrets/login have to be configured before enabling reporting; the PR
does not create production credentials or assert live activation. Only hashes,
never plaintext maintainer keys, enter GitHub Actions and Bunny. Rotating adds a
new hash, deploys, replaces the privately distributed key, then removes the old
hash and deploys again. A suspected leak requires immediate removal and redeploy.
There is no per-key identity, audit trail, MFA, or account-based authorization
in this initial maintainer-only implementation. Request logging remains disabled.

To close reporting, set its Actions variable to `0` and redeploy. Remove its
private credentials when no longer needed. Version/telemetry routes remain
independent. A rollback restores reporting only when both its verified artifact
and the current configuration enable it; pre-reporting artifacts close it.
Migrations remain additive. Do not reverse schema to roll back a bundle.

## Verification and query cost

`pnpm check` covers contracts, authorization, response whitelisting, redacted
failures, and the Bunny bundle. `node scripts/check-reporting-browser.ts` uses
an isolated headless browser and loopback server with synthetic data: access,
filters, injection-safe text, failure/retry, logout/reload, responsive layout,
and automated accessibility checks. CI retains synthetic screenshots only.

`pnpm test:storage` additionally runs reporting fixtures when
`REPORTING_DATABASE_URL` and `REPORTING_ROLE` identify a separate local fixture
login. CI supplies it. Fixtures exercise cross-tool/cloned projects, forks,
unknown projects, tool-scoped installations, CI, daily/period uniques, late
arrival, expiry, deletion, role isolation, and top-version ordering. They also
measure `EXPLAIN (ANALYZE, BUFFERS)` on 10,000 synthetic rows in a rolled-back
transaction. Sanitized evidence is in
[the measurement record](evidence/2026-10-27-reporting-query-plan.json).
It is a local PostgreSQL measurement, not a PlanetScale latency or scale claim.
Measure again privately on representative production volume before adding
indexes, caching, or rollups. The DB statement limit is 2.5 seconds and the
HTTP deadline is 2.8 seconds; an expensive query fails explicitly.

Detailed reporting retains exactly the existing 90-day horizon. Historical
monthly summaries are a separate [proposal](rfcs/0004-historical-usage-summaries.md)
within #13; no historical series is persisted or silently recovered from
backups by this implementation. Public exports remain #14.
