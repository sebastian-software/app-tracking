# Gated telemetry ingestion

Issue [#7](https://github.com/sebastian-software/app-tracking/issues/7) implements
registration and batch ingestion behind an explicit construction boundary.
The [v1 contract](telemetry-api.md), [wire schema](../contracts/telemetry-v1.schema.json),
and [policy](../contracts/telemetry-v1-policy.json) remain authoritative.

## Activation boundary

`createTelemetryService(databaseUrl)` builds the candidate handler. It has no
module-load network request, environment lookup, consent collection, or automatic
registration. Neither `src/edge.ts` nor the deployed version bundle imports it.
The build harness checks that separation. Version resolution remains independent
of PlanetScale and telemetry.

The candidate implements only:

- `PUT /v1/installations/{uuid7}`: `201 registered` or `200 duplicate`.
- `POST /v1/usage-batches`: `200 accepted` or `200 duplicate`.

Public telemetry stays disabled until production operations (#11) are ready.
The subsequent [lifecycle implementation](telemetry-lifecycle.md) adds DELETE
with bounded primary purges and scheduled retention. Installation routes now
advertise `Allow: PUT, DELETE`.
There is no release lookup in registration or batch acknowledgements.

## Input and transaction boundaries

The handler bounds header bytes and streamed body bytes, including requests
without Content-Length. Invalid UTF-8, a BOM, duplicate decoded object keys,
trailing data, compression, unknown fields, invalid dates/SemVer, invalid
project-field pairs, and duplicate dimensions are rejected. The bounded JSON
parser accepts exact equivalent integer spellings such as `1.0` and rejects
fractions that JavaScript would otherwise round into an integer. It limits
nesting before recursive processing.

Credential hashes use the contract's installation-bound domain separation.
Canonical JCS bytes contain the whole validated envelope and dimension-sorted
rows. The client cannot supply a hash or choose SQL. The acknowledgement echoes
the server-computed hash and identities; receipt timestamps are serialized as
UTC with millisecond precision. Responses, including errors, are no-store and
contain fixed error codes without driver messages or input values.

Migration `0002-telemetry-ingestion.sql` adds the v1 functions, command catalog,
and bounded upload-attempt state. Installation-row locking serializes authority,
receipts, quotas, and the rolling ten-attempts-per-minute limit across instances.
Wrong credentials cannot spend another installation's rate budget. Correctly
authenticated replays/rejections do spend it, without advancing usage activity or
daily usage quota. No edge-local counter decides authority or deduplication.

Retained receipts are checked before the current command catalog, total quota,
and age rules. A retired command can therefore replay an identical acknowledged
batch, but cannot enter a new batch. New receipt, per-day quota, contributions,
and last activity commit together. An inner transaction boundary rolls them all
back on rejection while preserving the authenticated attempt counter. Unexpected
SQL failures roll back the entire statement and return `503` as an unknown outcome.

Each installation holds at most ten recent attempt timestamps. Timestamps older
than sixty seconds stop counting and are pruned on the next authenticated upload.
The subsequent hourly retention job prunes idle state within the physical
cleanup bound. Revocation clears the attempt state.

The caller/request abort and the three-second handler deadline propagate to the
HTTP database call. An aborted or failed acknowledgement remains an unknown
outcome; retry the same batch ID and semantic content. The driver makes no
transparent application retries. There is no partial-batch success.

## Verification and migrations

`pnpm check` includes strict-wire tests, the independent canonical/hash vectors,
and a self-contained browser-targeted candidate build with the pinned driver.
Its bundle harness exercises the real driver serialization with synthetic
transport responses. This is not a live Bunny deployment claim.

`pnpm test:storage` runs the existing storage tests, then the real HTTP handler
against fixed SQL functions on PostgreSQL. CI uses an app-scoped owner/migrator
and a separate nonadministrative runtime login. Synthetic installations are
removed in `finally`; command-retirement checks run inside a rolled-back
transaction and never commit a shared catalog change.

For an explicitly invoked real PlanetScale HTTP run:

```sh
gh workflow run deploy.yml --ref BRANCH -f ingestion_test=true
```

This uses the existing encrypted `APP_TRACKING_MIGRATION_DATABASE_URL` and
`APP_TRACKING_RUNTIME_DATABASE_URL` Actions secrets. It applies additive,
checksummed migrations as `app_tracking_owner`, verifies runtime role defaults,
and grants the fixed functions. It sends no database credential to Bunny and
does not publish the candidate or alter the version deployment. Schema changes
roll forward; rolling back an application bundle does not reverse migrations.

On 2026-10-26, [run 40302187302](https://github.com/sebastian-software/app-tracking/actions/runs/40302187302)
passed 78 checks with the real PlanetScale HTTP driver, including eight concurrent
copies of a 256-row, 65,536-byte batch: one acceptance and seven duplicates.
A driver-layer acknowledgement loss after a committed write produced `503`,
followed by an identical retry returning `duplicate` without another contribution.
The run also covered competing different bodies, credential/declaration conflicts,
malformed/oversized/expired input, late SQL constraint failure, quotas, rate
limits, inactivity, and revocation. The local PostgreSQL variant passed 72
checks with two direct TCP sessions, plus the existing 26 storage checks.

These are synthetic correctness checks, not evidence of actual consent, adoption,
production capacity, or measured peak memory. The earlier Bunny/provider proof
and its memory-observation limit remain in the [storage runbook](storage-proof.md).
No real usage is collected by this increment.
