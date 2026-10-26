# Bunny–PlanetScale storage proof

This is the implementation and runbook for [issue #6](https://github.com/sebastian-software/app-tracking/issues/6).
It exercises the storage boundary with synthetic data. It does not enable the
public telemetry routes, consent collection, or a production reporting client.
The [telemetry contract](telemetry-api.md) remains authoritative.

## Shape

The candidate uses the existing Bunny Edge Scripting SDK 0.13.0 and the pinned
`@neondatabase/serverless` 1.2.0 driver in HTTP mode. PlanetScale documents
`https://<database-host>/sql` for this driver. The edge calls a parameterized
Postgres function once per operation, without persistent connections,
WebSockets, a row-by-row network loop, or cache-backed deduplication.

`db/migrations/0001-storage.sql` introduces the candidate schema:

- `reporting_installations`: immutable tool/installation identity, credential
  hash, consent declaration/context, activity, and finite lifecycle state.
- `telemetry_batches`: unique composite batch key, canonical-content hash, and
  original receipt time.
- `usage_counts`: batch-attributable contributions; composite foreign keys
  prevent crossing tool/installation boundaries.
- `daily_quotas`: installation/day counts updated with the receipt and usage.

The installation row is the shared write/revocation lock. A new batch writes
its receipt, updates daily quotas, bulk-inserts usage with
`jsonb_array_elements`, and advances activity in one statement transaction.
A duplicate returns the existing receipt without adding usage or activity.
A different content hash fails. A constraint violation anywhere rolls back
every write. Revocation takes the same lock before deleting contributions.
There is no denormalized aggregate store to repair.

This internal boundary expects the future HTTP layer to validate the exact
wire schema, raw JSON rules, command catalog, canonical hash, credential
hash, and request rate. The functions add database constraints, authority,
identity/time, row/count/quota and uniqueness checks. They are not a complete
implementation of issues #7 and #8. In particular, production error mapping,
rate limiting, expired-row visibility, tombstone cleanup, and scheduled
retention remain those issues' work. The probe deliberately uses a simpler
synthetic protocol and SQLSTATE-only failures, not the public v1 protocol.

## Credentials and migrations

Use one logical `app_tracking` database inside the existing shared Postgres
cluster. It has its own owner, migration and runtime roles. The existing
application's logical database and credentials are separate. Sharing compute
adds no second cluster but shares capacity, outages, and cluster backup/PITR.
Do not use cluster-wide grants to implement application isolation.

Keep `MIGRATION_DATABASE_URL` outside the edge runtime. Its dedicated managed
LOGIN role inherits only the stable, non-login `app_tracking_owner` role,
which owns this logical database and its schema/functions. It has no
`CREATEDB`, `CREATEROLE`, superuser, or cross-application membership. Runtime
uses a different managed LOGIN role with no inherited roles, database CONNECT,
schema usage, and execution on the three named functions. No table grants or
`pg_read_all_data`/`pg_write_all_data` membership are needed.

An administrator bootstraps the empty logical database, ownership, CONNECT
policy, and managed role membership once. When an administrator needs temporary
membership to transfer ownership, grant and revoke that membership in the same
transaction; it must not survive commit. Revoke PUBLIC access only on this
new database. Do not change another application's access policy.

Configure runtime/proof login defaults to `statement_timeout='2500ms'` and
`lock_timeout='1500ms'` before applying function grants. Each login can set
its own defaults with `ALTER ROLE CURRENT_USER SET ...`; the scoped migrator
needs no cluster-wide role-administration permission. `grant-runtime.ts`
checks these defaults and rejects privileged/inherited runtime roles.

```sh
MIGRATION_DATABASE_URL=... MIGRATION_OWNER_ROLE=app_tracking_owner pnpm db:migrate
MIGRATION_DATABASE_URL=... RUNTIME_ROLE=... node scripts/storage/grant-runtime.ts
```

The migration runner validates the owner name before `SET LOCAL ROLE`.
Its compatibility default remains `postgres`; shared-cluster deployment sets
`MIGRATION_OWNER_ROLE=app_tracking_owner` explicitly. Use app-scoped ownership
for shared deployments.

Supply secrets through the execution environment, not literal shell history
or committed files. The examples show variable names, not real values.
`psql` 16 or newer must be installed. Remote connections use TLS certificate
verification with the system trust store (`PGSSLROOTCERT=system`), unless an
explicit trusted CA file is supplied through that environment variable.
Only disposable local PostgreSQL tests use `sslmode=disable` on loopback.

The migration runner holds one transaction/advisory lock while checking the
version/SHA-256 journal and applying pending files. Existing migrations are
immutable after release. Add a new numbered migration for a later change.
A checksum mismatch or failed DDL rolls back; applying the same set again is
safe. The journal and schema belong to the stable application owner; the migrator
manages them through its owner membership. Runtime has no ownership.
Roll forward schema changes; an application-bundle rollback does not undo data.

Functions use `SECURITY DEFINER` with a fixed `pg_catalog` search path and
schema-qualified objects. Public execution is revoked. Runtime role defaults
bound statements to 2.5 seconds and lock waits to 1.5 seconds. The HTTP driver
has a 2.8-second deadline, without transparent application retries. A timeout
is an unknown outcome: retry the original batch identity and payload.

The runtime role cannot directly access application tables or create objects
in the application schema. PostgreSQL still allows harmless built-in queries;
this is not a database-wide ban on SQL. The edge exposes only fixed function
calls and never accepts caller-selected SQL or a database destination.

## Reproducible database tests

CI starts pinned PostgreSQL 18.6 in a disposable service container, creates an
app-scoped database owner/migrator and an unprivileged runtime role, and runs:

```sh
MIGRATION_DATABASE_URL=... MIGRATION_OWNER_ROLE=app_tracking_owner RUNTIME_DATABASE_URL=... RUNTIME_ROLE=... pnpm test:storage
```

The same suite runs against an isolated PlanetScale database before the edge
probe. It verifies clean/repeated migration, runtime privileges, composite
foreign keys, two concurrent direct-TCP duplicate claims, installation-lock serialization,
late insertion failure, full-transaction rollback, discarded acknowledgements,
and safe retry. It removes only installations it created; it does not clear an
existing dataset. Eight simultaneous direct-TCP process connections from GitHub Actions intermittently
ended with a closed connection before returning SQLSTATE. This suite uses two
connections to test database serialization, without automatic retries. The live
probe independently retains eight parallel requests through the HTTP driver.
The local run is evidence about Postgres behavior, not proof
of PlanetScale's proxy or Bunny runtime.

## Temporary live probe

Use the existing deployment workflow's `storage_proof` input. This runs a
short-lived authenticated Bunny probe against synthetic installations in the
database. It does not create a permanent staging environment or modify the
version deployment. The script and linked Pull Zone are removed after the run, with an additional
cleanup step for failure or cancellation.

Configure these repository Actions secrets before a live run:

| Secret                         | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `BUNNY_API_KEY`                | Existing organization deployment credential                                        |
| `PROOF_MIGRATION_DATABASE_URL` | Database setup and assertions; never sent to Bunny                                 |
| `PROOF_RUNTIME_DATABASE_URL`   | Unprivileged test role passed to the temporary script as an encrypted Bunny secret |
| `PROOF_RUNTIME_ROLE`           | Exact database role to grant/test, without the connection-routing suffix           |

Use a short expiry for the proof runtime login. Remove the temporary Actions
secrets after verification; retain production credentials separately when the
real telemetry service is ready. The per-run probe authorization token is
random, memory-only on the runner, and stored as an encrypted Bunny secret.
The probe logs no body, ID, SQL parameter, provider error, or credential.
Resource IDs and hostname stay in ignored `.deployment/` state.

```sh
gh workflow run deploy.yml --ref BRANCH -f storage_proof=true
```

The live suite sends 256 distinct synthetic rows, a body padded to exactly
65,536 bytes, eight concurrent copies, a changed-content conflict, an
acknowledgement discarded after commit, a caller timeout and identical retry,
and a late-insert failure followed by a fresh valid transaction with the same
uncommitted identity. Every successful operation must use one HTTP database
subrequest and complete in less than three seconds. Repeated requests must
bypass the CDN cache. It records first-observed and repeated latency, instance
reuse, and available Deno heap snapshots. A heap snapshot is not peak active
memory; process RSS is not an isolate-memory measurement. Do not substitute
local Node measurements for missing edge observations or promise behavior in
untested regions.

Only sanitized measurements become an artifact. No connection details,
provider IDs, probe hostname, report payloads, or real traffic are published.
If cleanup fails, the workflow fails and requires private inspection of the
run's temporary target. The runtime role's short expiry limits lingering
access; confirm removal rather than treating expiry as completed cleanup.

## Evidence and outstanding decisions

On 2026-10-26, the real PlanetScale database suite passed against Postgres
18.6 aarch64 on a shared PS-5 cluster in AWS Frankfurt (one primary, two
replicas). The migration role has no database/role creation privilege; the
runtime role can connect to the new logical database and cannot connect to
the existing application's logical database. The schema is owned by the
stable app-specific owner. Synthetic contributions are removed after each run.
Four retained backups were observed, none protected, with a two-day configured
retention. No restore was performed or claimed.

The real Bunny/HTTP-driver measurements are still outstanding. This is not
yet a successful end-to-end provider integration or a production telemetry
launch.

Normal PlanetScale backup/PITR remains the recovery approach. This proof adds
no restore service or separate deletion journal. Verify the actual configured
retention against the [retention policy](telemetry-retention.md) before
telemetry launch; processor/logging/transfer review remains issue #11.

Primary references checked on 2026-10-24:

- [PlanetScale HTTP driver configuration](https://planetscale.com/docs/postgres/connecting/neon-serverless-driver)
- [PlanetScale managed roles](https://planetscale.com/docs/postgres/connecting/roles)
- [Neon driver 1.2.0 configuration](https://github.com/neondatabase/serverless/blob/v1.2.0/CONFIG.md)
- [Bunny runtime](https://bunny.net/docs/scripting/runtime)
- [Bunny limits](https://bunny.net/docs/scripting/limits)
- [Bunny encrypted secrets](https://bunny.net/docs/scripting/secrets)
