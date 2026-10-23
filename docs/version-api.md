# Version API

This is the implemented version-only contract from issue #1. It runs locally
and builds for Bunny. Production hosting, CDN configuration, regions, logging,
and rollback must pass [issue #2](https://github.com/sebastian-software/app-tracking/issues/2).
No production endpoint is declared here.

## Requests and catalog

`GET /v1/versions/{tool}/{distribution}/{channel}` returns release metadata.
`GET /health` returns `{"status":"ok"}` with `Cache-Control: no-store` and
does not contact an upstream service.

The [catalog](../src/catalog.ts) owns supported mappings. Initial mappings were
checked against public metadata on 2026-10-22:

| Tool        | Distribution | Channel  | Authoritative source                                       |
| ----------- | ------------ | -------- | ---------------------------------------------------------- |
| `dalo`      | `npm`        | `stable` | `getdalo`, npm `latest` tag                                |
| `dalo`      | `standalone` | `stable` | `sebastian-software/dalo`, latest published GitHub release |
| `palamedes` | `npm`        | `stable` | `@palamedes/cli`, npm `latest` tag                         |

For npm, the selected tag must name a matching, nondeprecated version manifest
with a valid publication time. The registry's full package metadata is bounded
to 2 MiB. The service does not infer npm readiness from a GitHub release or from
unreleased repository code. It does not verify every optional platform package
or download package contents.

For standalone Dalo, the `dalo-v` tag must contain a stable SemVer, and all five
configured macOS/Linux binary archives must be uploaded and nonempty. A newer
incomplete release is unavailable until complete; the service can temporarily
serve its retained prior successful result as described below. It does not
scan older GitHub releases or certify binary signatures/content.

Other distributions and channels are unsupported. In particular, Palamedes's
inspected GitHub release has no standalone binary assets and its Rust package
is not published to crates.io. A future catalog change needs distribution-specific
evidence and tests; a repository tag alone is insufficient.

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
  "release_url": "https://www.npmjs.com/package/getdalo/v/1.2.3",
  "checked_at": "2026-10-22T09:00:00.000Z",
  "stale": false
}
```

This synthetic example is exercised as a [contract fixture](../test/fixtures/version.json).
`published_at` is the selected distribution's publication time. `checked_at`
is the time of the last successful source validation. Both are UTC timestamps.
The current parser accepts UTC source timestamps with seconds or milliseconds
and tolerates at most five minutes of future source clock skew.

Release links are constructed from reviewed catalog destinations and validated
versions. Untrusted upstream links are not forwarded. The client compares
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
one-hour validation deadline, capped at 3,600. Serving a warm response does not
restart its lifetime. Shared caches must respect these headers and must not
ignore query strings or serve cached successes for invalid requests.

The strong ETag is the SHA-256 of the exact response bytes. A matching
`If-None-Match` (including a weak validator, a matching item in a list, or `*`)
returns `304` with no body, the current ETag, and the same cache policy.
Conditional requests still validate input and resolve current freshness. A
successful source refresh changes `checked_at`, so it can change the ETag even
when the version remains unchanged.

On refresh failure, a retained result younger than 24 hours returns `200` with
`stale: true`, its original `checked_at`, and `Cache-Control: no-store`. Changing
`stale` also changes the ETag. Once the age reaches 24 hours, no stale result is
returned. Errors and stale responses must not receive an extra CDN freshness
window. Registry-publication lag and the client's own hourly check interval can
still delay notification; there is no one-hour end-to-end guarantee.

The initial last-success cache and concurrent-refresh coalescing are bounded
to catalog entries in one service instance. They are not durable or shared
between Bunny isolates. Cold starts and eviction remove stale fallback; an
outage then returns `503`. This implementation does not use Bunny's Cache API,
PlanetScale, a second release feed, or persisted reporting state. Cross-instance
cache behavior and cold/warm outage delivery require the deployment proof.

Only transport failures and upstream 5xx responses receive the one retry.
Other statuses, malformed metadata, invalid versions, and oversized bodies are
unavailable without an immediate retry. Redirects are forbidden. Incoming
credentials, cookies, user agents, and custom headers are not forwarded to
registries. Source requests use a fixed service user agent and no credentials.
Anonymous GitHub API rate limits can therefore cause temporary unavailability.

## Errors

Errors have `Cache-Control: no-store` and a fixed JSON shape:

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
an SDK upgrade must pass the bundle check and staging proof again.

Current primary references:

- [npm registry metadata API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [Dalo npm manifest](https://github.com/sebastian-software/dalo/blob/main/npm/package.json)
- [Palamedes CLI manifest](https://github.com/sebastian-software/palamedes/blob/main/packages/cli/package.json)
- [Palamedes Rust publishing policy](https://github.com/sebastian-software/palamedes/blob/main/Cargo.toml)
- [Bunny runtime](https://bunny.net/docs/scripting/runtime)
- [Bunny cache behavior and Pull Zone constraints](https://bunny.net/docs/scripting/cache)
