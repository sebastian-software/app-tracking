# Generic event batches

This version-1 counter contract is separate from the legacy
[CLI invocation contract](telemetry-api.md). It uses no new telemetry protocol
generation and does not activate reporting for existing consumers.

## Submission

`POST /v1/event-batches` accepts JSON, at most 60,000 bytes and 64 distinct
dimension rows. Cookies, content encoding, query strings, fragments, unknown
fields, and duplicate JSON keys are rejected. Headers cap at 16 KiB. Responses
use `Cache-Control: no-store`. The server deadline is three seconds.

| Field             | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `schema_version`  | Exactly `1`.                                                                     |
| `tool_id`         | Registered product catalog key.                                                  |
| `batch_id`        | Random 64-character lowercase hexadecimal delivery ID, stable across retries.    |
| `collection`      | `opt_out` or `opt_in`; must match every registered metric in the batch.          |
| `mode`            | `local` or `ci`.                                                                 |
| `installation_id` | Only for opt-in: random tool/service/profile-scoped 64-character hexadecimal ID. |
| `consented_at`    | Only for opt-in: epoch milliseconds of the explicit grant.                       |
| `rows`            | Nonempty array of counter rows.                                                  |

An opt-in batch requires a 64-character hexadecimal bearer credential. The
first valid batch claims the installation ID and immutable credential hash,
grant timestamp, and mode. Subsequent requests authenticate that identity.
The database stores SHA-256 of the credential. The client keeps the credential
only in private local state. Initial registration rejects grants older than
90 days; grant timestamps more than five minutes in the future are rejected. A client declaration is not attestation
that an official binary ran or that a human made the declaration.

Opt-out batches have no bearer credential, installation ID, or grant timestamp.
The receiver validates their registered metrics without assigning an
installation identity. Neither route trusts client-supplied metric definitions.
The initial product catalog contains no production baseline metric; fixtures
exercise the mechanism with a separate synthetic catalog entry. Opt-out
definitions must use `system: "none"` and cannot enable project context; the
SDK, receiver, and database catalog enforce this boundary. A baseline label
alone does not establish a legal basis for a new local observation. Functional
[service statistics](service-statistics.md) use their own server aggregate table
and never enter this client-event route.

## Counter rows

Each row has `day` (integer UTC epoch day), `metric`, matching `collection`,
exact SemVer `tool_version`, finite categorical `dimensions`, and integer
`count` between 1 and 1,000,000. Accept the current UTC date and preceding six
dates. Complete dimensions excluding `count` must be unique within a batch.
Batch counts cap at ten million. Quotas cap at ten million per tool/principal/
UTC day; baseline quotas are shared by tool and mode, and opt-in quotas use the
tool-scoped installation identity. These limits are bounds, not bot attestation.

The metric's registered system profile determines whether `system` is absent,
contains platform context, or includes full context. Shared keys are `os`,
`os_version`, `arch`, and `cpu_family`. Linux full context may additionally have
`linux` with `distribution`, `distribution_version`, and `kernel_version`.
Only the bounded categories in client/receiver validation are accepted.

A metric may additionally permit the existing `project_id` (64 lowercase
hexadecimal characters) and `project_id_version` (exactly `1`) pair. They are
optional together and accepted only on the opt-in route. The SDK resolves
this context lazily and uses the shared repository normalization contract.

The [catalog](../contracts/event-catalog.json),
[receiver validation](../src/telemetry/events.ts), and
[SQL boundary](../db/migrations/0008-generic-events.sql) define exact allowed
values. A new metric using existing primitives requires catalog registration
and deployment, without a tool-specific handler branch. Preserve old allowed
values while previously shipped clients/queued data still need them.

## Receipts and storage

Canonical JSON sorts object keys recursively, retaining array order. The
receiver calculates SHA-256 of those bytes. On success it returns HTTP 200 with
exactly `batch_id` and `payload_sha256`. Retrying the same authenticated identity,
batch ID, and hash returns the same receipt without incrementing counts.
Conflicting hashes or identity ownership return a conflict.

One transaction validates the trusted catalog, authenticates/claims identity,
checks a retained receipt, updates quotas, and inserts the batch and counts.
Invalid rows roll the transaction back. A runtime login receives only the two
fixed submission/deletion functions; it cannot edit catalogs or query tables.

Counters, identity state, and receipts are stored separately from legacy CLI
tables. New counters do not contribute to existing invocation charts.
`reporting_events_v1` hides revoked/inactive identities and expired counts.
Registration requires a grant no older than 90 days. Registered identities
expire after 90 days of inactivity; continuing acknowledged uploads preserve
the identity without asking for renewed consent on a fixed calendar schedule.
It has no public or ordinary runtime SELECT grant.

## Deletion and retention

`DELETE /v1/event-installations/{installation_id}` requires its bearer
credential and `App-Tracking-Tool` header. It immediately revokes visibility
and deletes up to 100 batches per call. HTTP 202 means another page is needed;
HTTP 204 confirms completion. An authenticated unknown-identity response is
`installation_not_found`. A generic routing 404 is not deletion confirmation.
Old identity credentials remain local until confirmation; deletion does not
enable another identity automatically.

Counter detail is retained for at most 90 UTC days plus scheduled cleanup lag;
receipts and inactive identity state expire after 90 days. The existing
maintenance workflow drains bounded event cleanup pages before completing its
legacy pass. An older deployment without migration 0008 still performs legacy
retention. No indefinite aggregate history or public export is added here.

Deploy the additive migration and runtime grants before moving consumers to
this contract. Legacy consumers continue to use their existing API and state.
