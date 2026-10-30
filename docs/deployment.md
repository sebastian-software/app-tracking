# Bunny deployment

Functional service statistics use the independent repository switch
`APP_TRACKING_SERVICE_METRICS_ENABLED`. The [service-statistics contract](service-statistics.md)
owns its source, opt-out, disclosure, migration, grants, rollback, and coverage.
Existing deployments remain off until that switch is set; no end-user opt-in
is required for the selected server-only design.

Changes to main deploy directly to one Bunny Edge Script and its linked Pull
Zone. The `Deploy app-tracking` workflow runs `pnpm check`, configures the
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

Only fresh public version responses are shared-cache candidates. Explicitly
stale version results remain usable for less than 24 hours from their original
collection time and must bypass the CDN; deployment verification accepts this
contract state without pretending that the upstream refreshed. Provisioning
respects origin Cache-Control, preserves query distinctions, disables error
caching and stale background/offline responses, and disables Pull Zone access
logging, forwarding, and log storage. Health, invalid requests, and future
private routes bypass shared caches.

Every deployment checks all configured distributions, revision headers, an
observed CDN HIT and conditional requests for fresh data, bounded age and
uncached handling for stale data, invalid-query rejection,
and repeated uncached health/admin/report paths. Deterministic tests cover
snapshot failure, release eligibility, retry limits, cold outages, and maximum retained stale age.
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

Version data comes only from the CDN-cached oss-metrics snapshot. A release
must be at least one hour old. Source freshness is one hour from its original
`generatedAt`, with explicitly stale results limited to 24 hours. Client check
intervals add their own delay. Version delivery has no database dependency and
never directly queries private usage analytics. The [version API
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

## Synthetic database integration proof

The optional `storage_proof` workflow input runs a temporary authenticated probe
with separate database credentials. It does not deploy the version service or
introduce a permanent staging environment. See the [storage proof
runbook](storage-proof.md) for setup, measurements, and cleanup.

## Opt-in telemetry runtime

The same bundle includes a lazily constructed telemetry handler. The Actions
variable `APP_TRACKING_TELEMETRY_ENABLED=1` enables its deployment configuration;
unset or `0` keeps private routes closed. Enabling requires the operations and
processor checks in [the operations runbook](operations.md). Source code or a
merged consumer alone does not authorize or establish activation.

Before publishing an enabled revision, the workflow applies checksummed additive
migrations, verifies the existing unprivileged runtime role and effective query
logging, and sends only the runtime URL to the Edge Script's encrypted
`APP_TRACKING_DATABASE_URL` secret. The migration URL stays in Actions.
`APP_TRACKING_TELEMETRY_ENABLED` is a separate runtime secret, evaluated on
telemetry routes. Version and health requests never construct storage.

Provisioning also sets the provider's per-IP request limit to 20 requests/s and
burst to 40. This zone-wide gateway limit is a basic abuse brake, not global
registration deduplication or proof of an authentic binary. Shared NATs can hit
it. Provider rejections can differ from application JSON; clients must back off.
Authenticated upload limits remain installation-scoped in SQL. Deletion has no
upload quota and remains retryable after a gateway rejection.

### Bunny Shield

Production deployment also runs `scripts/shield.ts --apply` against the exact
`app-tracking` script's `sebastian-app-tracking` pull zone. It selects Shield
Basic explicitly; Bunny's recommended defaults currently select paid Advanced.
The script never upgrades a plan, changes custom rules, or configures temporary
proof endpoints. Basic includes request-based overage billing; check the
[current provider terms](https://bunny.net/shield/) when reviewing traffic costs.

The maintained settings enable blocking WAF rules and low-sensitivity DDoS
protection, disable request-body/header logging, and avoid forced browser
challenges for CLI consumers. It also reads and maintains the existing gateway
limit of 20 requests per second per IP with a burst of 40. That zone-wide limit
includes version and deletion routes; clients must back off and retry deletion
after gateway rejection. Shared NATs can hit a limit. No paid bot-detection,
upload-scanning, or custom rate-limit add-on is requested.

The [Shield v1 OpenAPI](https://api.bunny.net/shield/docs/v1/swagger.json) owns
the provider enums. Writes are followed by configuration read-back. Repeating
the command is idempotent; unexpected plans, ambiguous zone ownership,
or a failed read-back stop deployment without deleting operator-owned settings.

Read the current configuration without changing or deploying the service:

```sh
gh workflow run deploy.yml -f shield_read_check=true
```

Reapply and verify only the fixed Shield configuration:

```sh
gh workflow run deploy.yml -f shield_apply=true
```

The workflow uses the existing Actions secret. It logs selected settings and
pass/fail only. Provider security processing remains subject to Bunny's terms;
disabled application/CDN logging is not a zero-IP-processing claim. Shield
reduces flooding and automated abuse; it cannot attest authentic tool usage.
No proof-of-work, fingerprinting in the clients, or additional client protocol
is required. Rust and Node continue to handle gateway failures with their
existing bounded transport behavior.

Enabled deployments verify repeated unauthenticated cache bypass, then use an
owned synthetic identity to prove registration, acceptance, replay, conflicting
replay rejection, credential isolation, and deletion through the real CDN. The
probe retains cleanup authority only in ignored, private runner state and
retries cleanup in an `always()` step. Public output contains pass/fail only.
Admin and public aggregate routes remain disabled.

The same enabled deployment verifies `/v1/event-batches` with a separate owned
synthetic identity: acceptance, an identical replay receipt, conflicting replay
rejection, credential isolation, deletion, and rejection after deletion. Its
cleanup authority stays in `.deployment/event-probe.json` with private file
permissions. A generic routing 404 does not count as confirmed deletion; cleanup
state is retained for retry. Neither probe reads real traffic.

Release manifests record whether telemetry was enabled. Rollback restores the
original artifact and its effective activation state, honoring a current `0`
kill switch. Older manifests default to closed telemetry. Additive schemas and
runtime credentials are retained; rollback never drops tables or reverses
migrations. A normal deployment restores main afterward.

The manifest's `events` capability records whether the bundle implements generic
events. Restoring an older artifact without this field verifies the existing
version and invocation endpoints and expects generic routes to be absent.
It leaves migration 0008 and its data intact. During that rollback, unified
clients retain bounded pending batches and back off; legacy clients continue
using their original endpoints. Redeploy main to restore generic event delivery.

## Published unified-client verification

Deploy migration 0008 and the generic event routes before publishing/adopting
the new client. Verify the old-artifact rollback and restoration of current main
before consumer migration. Merge the Release Please PR only after the service
is ready, then wait for the matching GitHub release and crates.io publication.

The existing deployment workflow can verify an exact published crate without
deploying another bundle:

```sh
gh workflow run deploy.yml --ref main -f event_client_version=VERSION
```

This builds a standalone consumer from crates.io, proves that noninteractive
permission requests do not prompt and refusal creates no reporting identity,
then explicitly authorizes an isolated synthetic CI profile. It records one
language counter, downloads and verifies the public health resource, and lets
the SDK worker upload both counters. Database assertions are limited to this
run's random installation identifier. The client then requests authenticated
deletion, and the check confirms that its usage rows and batches are gone.
The synthetic version is `0.0.0-app-tracking-probe`.

The proof uses the existing Actions migration secret only in its parent
verification process, never in Cargo/build scripts or the native consumer.
The `always()` cleanup step retries only the identity created by this run.
Public output contains pass/fail assertions and the public crate version.
Consumer adoption, Node support, shared device profiles, and the generic-event
dashboard remain separate work; see [issue #48](https://github.com/sebastian-software/app-tracking/issues/48).
