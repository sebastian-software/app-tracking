# Version API

This is the version-only contract. The Bunny deployment and rollback procedure
are described in the [runbook](deployment.md). Update delivery creates no client reporting identity and does not require
consent to additional usage reporting. Optional aggregate
[service statistics](service-statistics.md) count eligible functional requests
without a client probe; DNT/GPC exclude a request from those statistics.

## Requests and catalog

`GET /v1/versions/{tool}/{distribution}/{channel}` returns release metadata.
`GET /health` returns `{"status":"ok"}` with `Cache-Control: no-store` and
does not contact an upstream service.

The [catalog](../src/catalog.ts) owns supported mappings. All installations of
a tool use one GitHub release version from the existing public
[oss-metrics snapshot](https://metrics.sebastian-software.com/v1/metrics.json).
app-tracking makes no separate GitHub, npm, Homebrew, or crates.io lookup.

| Tool        | Canonical distribution | Channel  | Snapshot field             |
| ----------- | ---------------------- | -------- | -------------------------- |
| `dalo`      | `github`               | `stable` | `github.dalo.release`      |
| `palamedes` | `github`               | `stable` | `github.palamedes.release` |

The existing Dalo `npm` and `standalone` routes and Palamedes `npm` route remain
compatibility aliases. They return the same GitHub release as the canonical
route, with their requested distribution label. New integrations use `github`;
the label selects a release feed, not proof of package-manager readiness.

oss-metrics already collects GitHub's `latestRelease` through GraphQL and caches
its public document on Bunny for one hour. It supplies tag, plain version, and
`publishedAt`. app-tracking requires snapshot schema 1, successful `github` and
`releases` source states, a stable SemVer matching the reviewed tag prefix, and
valid timestamps. Other statistics sources may fail without invalidating
release metadata. Arbitrary upstream links are ignored.

A release must be at least one hour old before it becomes eligible. This allows
normal downstream publication to catch up without maintaining independent
registry feeds. It is not a guarantee of npm, Homebrew, Cargo, Nix, or Debian
availability, nor an asset/signature verification. If the latest release is too
young, a retained eligible result may be served as described below. A cold
instance returns `503` until an eligible release is available; it does not scan
older releases or fabricate a previous version.

The snapshot must have a nonfuture `generatedAt` younger than 24 hours, and the
release cannot have been published after that snapshot. `checked_at` is the
snapshot's original `generatedAt`, not the time app-tracking fetched it. Thus a
CDN stale response cannot receive a renewed freshness or stale lifetime here.

Other tool mappings and channels are unsupported. Adding a tool requires a
reviewed repository/tag mapping and release metadata in oss-metrics. It does
not require a separate mapping for every package manager.

Paths are exact and case-sensitive. Encoded names, extra path segments, and
trailing slashes are rejected. Nonempty query strings, request
bodies, and transfer-encoded GETs are rejected. An empty `?` is equivalent to no query because Bunny normalizes it before cache lookup. Only GET is supported; there is
no legacy `/check` route or telemetry endpoint in this slice. The installed
version, repository URL/hash, installation identity, and invocation counts are
never request inputs.

## Successful response

```json
{
  "schema_version": 1,
  "tool_id": "dalo",
  "distribution": "npm",
  "channel": "stable",
  "latest_version": "1.2.3",
  "published_at": "2026-10-21T08:00:00.000Z",
  "release_url": "https://github.com/sebastian-software/dalo/releases/tag/dalo-v1.2.3",
  "checked_at": "2026-10-22T09:00:00.000Z",
  "stale": false
}
```

This synthetic example is exercised as a [contract fixture](../test/fixtures/version.json).
`published_at` is the GitHub release publication time. `checked_at`
is the original oss-metrics collection time (`generatedAt`). Both are UTC timestamps.
The current parser accepts UTC source timestamps with seconds or milliseconds
and tolerates at most five minutes of future source clock skew.

Release links are constructed from reviewed catalog destinations and validated
tags. Untrusted upstream links are not forwarded. The client compares
versions locally and supplies installation-specific instructions; the service
does not send shell commands or replace executables.

## Freshness, ETags, and outages

The [resolver](../src/resolver.ts) owns these limits:

| Rule                                            | Current limit                                      |
| ----------------------------------------------- | -------------------------------------------------- |
| Successful validation remains fresh             | Less than one hour                                 |
| Maximum age of a retained result during failure | Less than 24 hours since `checked_at`              |
| Failure suppression                             | One minute per catalog entry, per service instance |
| Upstream attempts per refresh                   | At most two                                        |
| Timeout per upstream attempt                    | 1,500 ms, including body streaming                 |
| Delay before the one retry                      | 50 ms                                              |
| Maximum upstream body                           | 2 MiB of streamed bytes                            |

Fresh responses are `200` with `Cache-Control: public, max-age=0,
s-maxage=N, must-revalidate`. `N` is the remaining whole seconds until the
one-hour snapshot freshness deadline, capped at 3,600. Serving a warm response does not
restart its lifetime. Shared caches must respect these headers and must not
ignore query strings or serve cached successes for invalid requests.

The origin strong ETag is the SHA-256 of the exact response bytes. Bunny may
mark it weak during delivery; clients must treat validators as opaque values. A matching
`If-None-Match` (including a weak validator, a matching item in a list, or `*`)
returns `304` with no body, the current ETag, and the same cache policy.
Conditional requests still validate input and resolve current freshness. A newer oss-metrics snapshot changes `checked_at`, so it can change the ETag
even when the version remains unchanged. Re-fetching the same snapshot does not.

On refresh failure, a retained result younger than 24 hours returns `200` with
`stale: true`, its original `checked_at`, and `Cache-Control: no-store`. Changing
`stale` also changes the ETag. Once the age reaches 24 hours, no stale result is
returned. Errors and stale responses must not receive an extra CDN freshness
window. The minimum release age, snapshot/CDN caching, and the client's own hourly
check interval add delay; there is no one-hour end-to-end guarantee.

The initial last-success cache and concurrent-refresh coalescing are bounded
to catalog entries in one service instance. They are not durable or shared
between Bunny isolates. Cold starts and eviction remove stale fallback; an
outage then returns `503`. Release resolution does not use Bunny's Cache API, PlanetScale, a second
release feed, or client reporting state. Separately enabled background service
statistics may persist shared request counters in PlanetScale; they cannot
block release resolution or change its response. A cold
oss-metrics collection can be slower than the lookup budget because it also
collects other statistics. Such a request remains advisory and unavailable
until the CDN has refreshed; app-tracking never falls back to another source.
Stale snapshots are retried at most once a minute per route and instance.

Only transport failures and upstream 5xx responses receive the one retry.
Other statuses, malformed metadata, invalid versions, and oversized bodies are
unavailable without an immediate retry. Redirects are forbidden. Incoming
credentials, cookies, user agents, and custom headers are not forwarded to
oss-metrics. Source requests use a fixed service user agent and no credentials.
GitHub collection and its credentials remain owned by oss-metrics.

## Errors

Application errors have `Cache-Control: no-store` and a fixed JSON shape.
Live Bunny delivery can rewrite that header to `no-cache` for 503 responses;
error caching must remain disabled. Deployment verification checks preserved error JSON and
`Retry-After` plus repeated cache bypass. Infrastructure errors can additionally
occur outside the application; clients must handle status and retry behavior
even when an intermediary supplies a non-JSON error body.

Application error example:

```json
{ "schema_version": 1, "error": { "code": "release_unavailable" } }
```

| Status | Code                       | Meaning                                                                                      |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| `400`  | `invalid_request`          | Query, fragment, or body is present                                                          |
| `405`  | `method_not_allowed`       | Only GET is accepted; `Allow: GET` is set                                                    |
| `404`  | `not_found`                | Path is not a supported route                                                                |
| `404`  | `unknown_tool`             | Tool is not in the catalog                                                                   |
| `404`  | `unsupported_distribution` | Tool has no mapping for that distribution                                                    |
| `404`  | `unsupported_channel`      | Distribution has no mapping for that channel                                                 |
| `503`  | `release_unavailable`      | Source failed or was invalid, and no usable retained result exists; `Retry-After: 60` is set |

Responses never echo request values, upstream bodies, credentials, or exception
details. Application code has no per-request logging or analytics calls.
Provider/transport logs remain a separate deployment concern.

## Build and validation evidence

`pnpm check` runs formatting, type checking, synthetic contract and real
loopback HTTP tests, and a deployment-bundle check. The last check runs the
actual bundled SDK in a local harness exposing `Bunny.v1.serve`; it verifies
registration and handler behavior, not Bunny's infrastructure.

Node is pinned in [.node-version](../.node-version). pnpm and dependencies are
pinned in [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml).
The build uses the installed SDK's `esm-bunny` entry, packages its MIT notice,
and rejects external imports. No dependency installation scripts are required.
The SDK's internal entry path is a deliberate version-specific build dependency;
an SDK upgrade must pass the bundle check and live deployment probe again.

Current primary references:

- [oss-metrics release collector](https://github.com/sebastian-software/oss-metrics/blob/3333a430432f064516409a4bcb6b39aea48cb675/src/collect.ts#L180-L238)
- [oss-metrics CDN configuration](https://github.com/sebastian-software/oss-metrics/blob/3333a430432f064516409a4bcb6b39aea48cb675/scripts/provision.ts#L45-L65)
- [oss-metrics public contract](https://github.com/sebastian-software/oss-metrics/blob/3333a430432f064516409a4bcb6b39aea48cb675/README.md#endpoint)
- [Bunny runtime](https://bunny.net/docs/scripting/runtime)
- [Bunny cache behavior and Pull Zone constraints](https://bunny.net/docs/scripting/cache)
