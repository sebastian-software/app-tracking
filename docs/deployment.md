# Bunny version deployment

Changes to main deploy directly to one Bunny Edge Script and its linked Pull
Zone. The `Deploy version service` workflow runs `pnpm check`, configures the
service, publishes the bundle, purges the CDN, and verifies the live API. Pull
requests run checks without deploying. There is no separate staging environment
or manual promotion gate.

The workflow uses the organization Actions secret `BUNNY_API_KEY` only for
deployment. No account credential enters the runtime bundle. Resource IDs and
generated hostnames stay in ignored `.deployment/` runner files. Existing
services and custom hostnames are not changed.

## Release and rollback

Each bundle carries its commit in `X-App-Revision`. Provisioning creates missing
resources and converges cache and logging settings on later runs. Unexpected
edge rules stop deployment rather than silently overriding route policy.
Deployments run serially.

After successful live verification, the workflow retains a `verified-release`
artifact for 90 days. It contains `edge.js` and a manifest with the original
commit and SHA-256, without deployment identifiers.

To deploy main again:

```sh
gh workflow run deploy.yml --ref main
```

To restore a previous successful deployment, select its original run ID:

```sh
gh workflow run deploy.yml --ref main -f release_run=RUN_ID
```

Restoration downloads the original artifact, checks its hash and main-branch
ancestry, publishes those exact bytes, purges the CDN, and verifies the restored
revision and API. It does not rebuild old source with newer packages. A run
whose artifact has expired cannot be used for rollback.

A failed publish does not purge the CDN. A failed post-publication check marks
the run failed; inspect the live revision and restore a known-good artifact if
needed. Maintainers own deployment and recovery.

## Cache verification

Only fresh public version responses are shared-cache candidates. Provisioning
respects origin Cache-Control, preserves query distinctions, disables error
caching and stale background/offline responses, and disables Pull Zone access
logging, forwarding, and log storage. Health, invalid requests, and future
private routes bypass shared caches.

Every deployment checks all configured distributions, revision headers, an
observed CDN HIT, conditional requests, freshness, invalid-query rejection,
and repeated uncached health/admin/report paths. Deterministic tests cover
registry failure, retry limits, cold outages, and maximum retained stale age.
No synthetic failure bundle is published to the live service.

Initial live validation on 2026-10-23 also exercised same-node CDN expiry and
purge, synthetic registry outages and stale-age boundaries, and restoration in
a temporary test deployment. That deployment is not part of ongoing operation.
A successful live cache check is not a capacity benchmark.

Bunny can route consecutive requests to different edge nodes and weaken the
origin ETag. An empty query is normalized to the same public resource; nonempty
query fields remain invalid. Application 503 responses can arrive with no-cache
instead of no-store while preserving the JSON error and Retry-After. Repeated
error requests were verified not to be cache hits with error caching disabled.

Version source freshness is one hour, with an explicitly stale retained result
limited to 24 hours. Client check intervals add their own delay. Version delivery
has no database or reporting-service dependency. The [version API
contract](version-api.md) owns the exact response and retry limits.

## Logging and evidence

Application code logs no request payloads, URLs, credentials, or identifiers.
Disabled Pull Zone access logs do not imply that Bunny processes no IP addresses
or keeps no internal security/control-plane logs. Processor terms and internal
retention are provider/account matters; the service makes no zero-IP-processing
or EU-only routing claim.

Public evidence may contain revisions, pass/fail, change counts, cache state,
and aggregate latency. Keep account IDs, internal hosts, operator identities,
credentials, provider error bodies, and real traffic out of the repository and
workflow summaries.

API contracts were checked against Bunny's official OpenAPI documents on
2026-10-23: [Core](https://core-api-public-docs.b-cdn.net/docs/v3/public.json) and
[Compute](https://core-api-public-docs.b-cdn.net/docs/v3/compute.json).
