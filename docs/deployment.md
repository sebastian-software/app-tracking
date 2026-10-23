# Bunny version deployment

The `Deploy version service` workflow provisions isolated staging and production
scripts and zones. Staging runs on same-repository PRs and relevant main-branch
pushes. Fork PRs receive no deployment access. Production is manually dispatched
from main and requires a successful main-branch release run as `release_run`.

The account credential is the existing organization Actions secret
`BUNNY_API_KEY`. It is never a runtime secret. Resource IDs, generated hostnames,
and provisioning state stay in ignored `.deployment/` files on the runner.
No custom hostname or existing service is modified. The initial generated zone
names are defined by the workflow; staging and production have distinct names.

## Release and rollback

The workflow checks the pinned toolchain and builds a single edge bundle with
an `X-App-Revision` header on every response. Provisioning runs twice, and the
second run must converge. No broad edge rule can override route cache headers;
unexpected existing rules stop provisioning for review. Account mutation errors
never print provider bodies or credentials.

A new staging release uploads the bundle, publishes it, purges its isolated
zone, and verifies the endpoint. Only successful verification uploads the
`verified-release` artifact (90-day retention). It contains `edge.js` and a
manifest with the original commit and SHA-256, without deployment identifiers.

To promote or restore a bundle, dispatch the workflow with the target environment
and the successful original release run ID in `release_run`. The workflow checks
that the run belongs to this repository's deployment workflow on main and
succeeded, downloads its immutable artifact, verifies its hash and main-branch
ancestry, publishes the original bytes, purges the target zone, and verifies
revision and API behavior. It never reconstructs the old bundle with newer
packages. Artifact expiry makes that run unavailable for rollback; retain a
known-good release within the retention window.

A failed publication does not run the purge. A failed post-publication probe
marks deployment failed; it does not claim the previous release is still live.
Use the last known-good release run to restore explicitly. An interrupted
publish has an unknown outcome: inspect the revision endpoint before retrying.
Do not attempt to restore an unpublished draft obtained from the code API.

Set production environment protection to selected `main` deployments and the
maintainers' required approval policy before production use. Operator ownership
belongs to repository maintainers. The manual dispatch selects the verified
artifact and target; changes to production protection need separate review.

## Cache and operational proof

Pull Zone settings respect origin Cache-Control, preserve query distinctions,
disable Smart Cache exclusions for JSON, disable caching of errors and stale
background/offline responses, and disable access-log forwarding/storage. The
script continues to cache only approved fresh version successes through its
response headers. Health, invalid requests, errors, and future private routes
return no-store. The service's retained stale fallback remains per isolate.

The deployed probe checks all catalog routes, full revision headers, observed
CDN HIT within eight attempts, conditional 304 responses, checked-at freshness,
invalid-query rejection, and repeated uncached health/admin/report paths.
A missing HIT or an incorrect bypass fails the release. This intentionally
catches provider query normalization instead of assuming configuration suffices.
No probe performs production fault injection.

Before issue #2 is complete, record sanitized **live** evidence for:

- A second provision run with zero changes and distinct staging/production targets.
- Cold/warm hits, purge/eviction, real expiry, and ETag behavior on Bunny.
- Controlled registry failure and the maximum stale-age boundary in isolated
  staging; the deterministic tests alone are not evidence of platform behavior.
- A staging rollback to an older verified artifact and a subsequent re-promotion.
- Production protection, promotion, revision checks, and the privacy settings below.

The existing synthetic suite covers retry limits, stale expiry and cold outages;
these must not be described as completed staging drills. Cache API behavior and
CDN routing depend on actual provider settings. Bunny normalizes an empty query to the URL without a query, so both forms identify
the same public version resource. Nonempty query fields must still be rejected.

Initial operational targets: fresh source validation within one hour during
traffic, less than 24 hours for an explicitly stale retained result, at most two
1.5-second upstream attempts plus a 50 ms retry pause. Measure cold/warm endpoint
latency in staging before establishing an alert threshold. The combined server
freshness, publication lag, and client's hourly check can exceed one hour.
Monitor synthetic freshness/revision failures without installation, project, or
request-specific metric labels. Version delivery has no database or reporting
service dependency.

## Logging and evidence

Application code logs no request payloads, URLs, credentials, or identifiers.
Provisioning verifies Pull Zone access logging, forwarding, and storage are off.
This does not establish that Bunny has no internal security/control-plane logs.
Before production, verify processor terms and provider-internal retention and
record the result privately. Do not assert zero IP processing or EU-only routing
from a single cache or region setting.

Public evidence may state revision, pass/fail, change count, cache state and
aggregate latency. Keep actual account IDs, internal hosts, operator identity,
real traffic, credentials, and provider error bodies out of the public issue,
repository, and workflow summaries.

API contracts were checked against Bunny's official current OpenAPI documents
on 2026-10-23: [Core](https://core-api-public-docs.b-cdn.net/docs/v3/public.json)
and [Compute](https://core-api-public-docs.b-cdn.net/docs/v3/compute.json).
