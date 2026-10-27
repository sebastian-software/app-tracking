# Maintainer usage reporting

The private `/admin` view and `GET /v1/admin/usage` show consented CLI usage.
WorkOS AuthKit authenticates maintainers; the application requires the configured
WorkOS organization and `reporting:read` permission. A separate read-only
database login limits queries. CLI credentials and the earlier prototype keys
grant no access. Reporting is disabled by default and is independent of version
delivery and telemetry ingestion.

## Query contract

Request `/v1/admin/usage?from=2026-10-01&until=2026-10-28&tool=all&mode=local`
after signing in through `/admin/login`. The browser sends its encrypted
`__Host-app-tracking-session` cookie automatically. JavaScript cannot read it:
it is `Secure`, `HttpOnly`, host-only, `Path=/`, and `SameSite=Lax`. No token
enters local/session storage or the page. The public HTML shell contains no
usage data; the API verifies and authorizes the session on every query. There
is no bearer-key fallback. A reload keeps a valid session; logout clears it.

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

## WorkOS authentication boundary

`GET /admin/login` starts Hosted AuthKit sign-in for the configured application
and organization. The server keeps state and the PKCE verifier in a ten-minute
encrypted, HTTP-only `__Host-app-tracking-login` cookie. The callback requires
both the matching state and that cookie before exchanging a code. Only the
fixed `/admin/callback` redirect and `/admin` return path are used; no arbitrary
return URL is accepted. A second login attempt replaces the pending flow, so an
older tab may need to start again.

The locked WorkOS SDK handles code exchange, session sealing/unsealing, and
refresh-token rotation through its worker entry. `jose` verifies RS256 access
signatures with the application's HTTPS JWKS, exact configured issuer, expiry,
and a maximum token age of five minutes. `client_id` must match; if an `aud`
claim exists, it must include that client. User/session identifiers and an
`auth_time` are required. Agent/widget tokens, impersonation, unverified email,
a different organization, and missing `reporting:read` cannot access statistics.
An email domain, a role named `admin`, or any WorkOS account alone is insufficient.

Expired signed tokens are refreshed server-side once and the replacement
claims are checked again before access. The rotated encrypted cookie is sent
with the response, including a subsequent database error. Temporary refresh or
JWKS failures return 503 without clearing the cookie. Invalid authority returns
401; valid identity without access returns 403. Provider errors, tokens, account
identifiers, and cookie contents are never logged. SDK HTTP calls and JWKS
fetches each have a five-second deadline; automatic SDK retries are disabled.
Failed callbacks expose only a fixed phase/failure label in
`X-App-Tracking-Login-Failure`, under the same private cache policy. This header
contains no token, cookie, account identifier, URL, or provider error message.

Application sessions last at most seven days from `auth_time`; refresh does
not extend this maximum. WorkOS permission changes/revocation can remain unseen
until a current access token expires or reaches the five-minute age limit
(with five seconds of clock tolerance). This is not an immediate online
revocation check on every query. Configure short token/session lifetimes in
WorkOS too. Account recovery and MFA/passkey policy belong to Hosted AuthKit;
this PR does not claim they are configured on the live account.

`POST /admin/logout` requires the exact application Origin and the
`X-App-Tracking-Action: logout` header. It clears both local cookies, then the
view navigates to WorkOS's fixed logout URL to end the provider session. No
GET logout or cross-origin logout is accepted. Reload/back navigation rechecks
access before displaying statistics. The application writes no maintainer
accounts or sessions into the telemetry database and sends no usage counts,
repository hashes, or reporting-installation identities to WorkOS. WorkOS
processes maintainer identity/session data for this separate login purpose.

## Enable on the existing Bunny service

1. In the WorkOS operator team, configure the AuthKit application/environment
   for app-tracking. Create/select an **application organization** for approved
   maintainers; this is distinct from the operator team and GitHub organization.
   Give an explicitly assigned maintainer role `reporting:read`. Keep that
   permission off the default member role; do not enable automatic domain-wide
   admission as a substitute for explicit access. Configure the desired sign-in
   methods, recovery and MFA/passkey policy before using real maintainer accounts.
2. Register the existing Bunny base URL plus `/admin/callback` as the redirect
   URI, `/admin/login` as the initiate-login URI, and `/admin` as the default
   sign-out URI. The server integration needs no browser CORS origin or WorkOS
   JavaScript in the dashboard. Set access tokens to five minutes and the
   maximum session to seven days, with a six-day inactivity timeout (WorkOS
   requires inactivity to be shorter than the maximum). Read the exact `issuer`
   from `https://api.workos.com/user_management/<application-client-id>/.well-known/openid-configuration`
   and store it verbatim. This is the session-token issuer, usually containing
   `/user_management/client_...`; it can identify the environment's client rather
   than the selected application's client. The hosted AuthKit site's OAuth
   discovery document describes a different token issuer. Do not use that value
   or guess from a generic token example. Custom Authentication API domains
   require checking the corresponding discovery document again.
3. Create a **separate** app-specific PlanetScale PostgreSQL login. Do not reuse
   the ingestion, owner, migration, or maintenance login. It must have no role
   memberships or broad privileges. Deployment checks that isolation before the
   app's existing database owner grants CONNECT on its own database. The login
   sets its own `statement_timeout='2500ms'` and `lock_timeout='1500ms'` defaults;
   no role-administration privilege or manual SQL bootstrap is needed. Keep the
   runtime's effective query/parameter logging restrictions. Deployment also
   reads one day through the reporting HTTP driver and validates the aggregate
   response without logging statistics. Failures expose only a fixed stage and
   an allowlisted SQLSTATE code, HTTP status, or transport-failure category,
   never SQL, parameters, response bodies, or driver messages.
   Provider URLs may use either `postgres://` or `postgresql://` and native TLS
   parameters (`sslmode=require`, `verify-ca`, or `verify-full`, and
   `channel_binding=require`). The reporting HTTP adapter normalizes the scheme
   and removes these native transport parameters before using the verified
   HTTPS endpoint. Other connection parameters and duplicate options are rejected.
4. Configure encrypted repository Actions secrets below. Generate the cookie
   password as 32 random bytes encoded in 64 lowercase hexadecimal characters;
   keep it in a private credential store, never a public file, chat, or log.
   The WorkOS API key stays server-side. Do not add it to browser configuration.

   | Actions secret                        | Value                                      |
   | ------------------------------------- | ------------------------------------------ |
   | `APP_TRACKING_REPORTING_DATABASE_URL` | Separate aggregate-only database login     |
   | `APP_TRACKING_WORKOS_CLIENT_ID`       | AuthKit application client ID              |
   | `APP_TRACKING_WORKOS_API_KEY`         | WorkOS server API key for this environment |
   | `APP_TRACKING_WORKOS_ORGANIZATION_ID` | The permitted application organization     |
   | `APP_TRACKING_WORKOS_COOKIE_PASSWORD` | Private random session-encryption password |
   | `APP_TRACKING_WORKOS_ISSUER`          | Exact trusted access-token issuer          |

5. Set Actions variable `APP_TRACKING_REPORTING_ENABLED=1` and deploy main.
   Deployment validates authentication settings, applies additive migration
   0007, checks the database login's authority/logging, grants only schema usage
   and `admin_usage_v1(date,date,text,text)` execution, and writes encrypted
   Bunny secrets. It derives `APP_TRACKING_REPORTING_ORIGIN` from the provisioned
   Bunny base URL, not an incoming Host/forwarded header. Configuration failure
   stops deployment. No WorkOS account, role, key or production login is created
   by merging this code.
6. Bunny must preserve response cookies (`DisableCookies=false`); provisioning
   enforces this instead of inheriting the CDN's cookie-stripping default. The
   deployment verifier checks the public shell, unauthenticated API 401,
   repeated cache bypass, secure login cookies, separate logout-cookie deletion
   headers, and revision without private credentials. Cookie values are never
   printed by the probes. Then verify
   an actual WorkOS sign-in, unauthorized-account denial, refresh, and logout
   privately. Never publish real usage screenshots, tokens, account/resource
   IDs, or provider support material as evidence. Local tests simulate the
   provider and do not establish that WorkOS or Bunny's live cookie transport
   is configured correctly.

To close reporting, set its Actions variable to `0` and redeploy. Version and
telemetry routes remain independent. Rolling back restores reporting only when
both its verified artifact and current configuration enable it. Pre-reporting
artifacts close it; migrations remain additive. Rotating the cookie password
invalidates local sessions and pending login flows. Rotate WorkOS API keys
through the provider and encrypted secret stores; never add a shared-key login
fallback when WorkOS is unavailable.

Provider references: [AuthKit sessions](https://workos.com/docs/authkit/sessions),
[roles/permissions](https://workos.com/docs/authkit/roles-and-permissions),
[session tokens](https://workos.com/docs/reference/authkit/session-tokens), and
[session resilience](https://workos.com/docs/authkit/session-resilience). The
implementation is verified against `@workos-inc/node` 12.0.0's worker entry;
it does not depend on an unreleased framework adapter.

## Verification and query cost

`pnpm check` covers contracts, authorization, response whitelisting, redacted
failures, and the Bunny bundle. `node scripts/check-reporting-browser.ts` uses
an isolated headless browser and loopback server with synthetic data: access,
the real SDK, signed synthetic tokens, PKCE/callback, secure cookies, filters,
injection-safe text, failure/retry, logout/reload, responsive layout,
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
