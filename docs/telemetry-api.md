# Opt-in telemetry contract: v1

Status: implementation contract for issues #6–#12; telemetry is not enabled or
implemented by this document. The deployed service and Rust crate remain
version-only. This contract does not certify a production deployment or consent
flow. [ADR 0004](adr/0004-independent-updates-and-opt-in-telemetry.md) owns the
decision; [client consent](telemetry-consent.md) and
[retention](telemetry-retention.md) own the corresponding policies.

The [JSON Schema](../contracts/telemetry-v1.schema.json) owns wire shapes;
[policy values](../contracts/telemetry-v1-policy.json) own exact limits and the
initial command catalog. This page owns semantics and validation order. The
[synthetic vectors](../test/fixtures/telemetry/) are consumer conformance inputs.
The gated server implementation passes them at its HTTP boundary; the future
Rust telemetry client must pass them at its own boundary. See the
[ingestion runbook](telemetry-ingestion.md) for implementation and live-test evidence.

## Measurement and fields

Measure invocations, active reporting installations, known reporting projects,
command distribution, and version adoption among consenting installations.
These are not people, all installations, or total adoption. Opt-in bias, resets,
shared profiles, copied state, late/lost batches, and fabricated clients affect
coverage. Sum counts; deduplicate installation/project identities over the whole
requested period rather than adding daily distinct counts.

An invocation is one successfully parsed command entering the native command
dispatcher, regardless of the operation's eventual exit status. Count it once,
not once in npm and again in Rust. Exclude help/version, completions, manpage,
assistant maintenance, telemetry controls, and automatic/background executions
(including scheduled autosync execution). Explicit autosync management commands
can count. Embedded library calls never report automatically. JSON output and
non-TTY execution can count after consent; neither establishes agent use.

Initial telemetry registration supports **Dalo only**. Palamedes version checks
remain supported, but reporting is unavailable until its reviewed command
catalog and consumer adoption are added. The Dalo catalog contains top-level
command categories; nested operations collapse into their category. Classify
new unmapped command categories locally as `other`, never as arbitrary strings.
Adding a category within the same disclosed purpose requires a reviewed catalog
change; adding a dimension or purpose requires a new consent revision.

Each row contains UTC `day`, exact SemVer `tool_version` (at most 128 ASCII
characters; core numeric components at most ten decimal digits), allowlisted `command`,
and integer `count`. Known projects additionally contain `project_id` (64
lowercase hex digits) and `project_id_version: 1`. Omit both for unknown/global
context; no null, empty string, sentinel hash, or guessed directory identity.
Keep unknown-project invocation counts visible in reporting. A monorepo or
repository cloned by several developers has one project identity across tools.
[ADR 0005](adr/0005-repository-derived-project-identity.md) owns this meaning;
issue #9 owns executable URL-normalization rules. Schema validation cannot prove
that a hash came from a repository.

`mode` is immutable registration context (`local` or `ci`), inherited by every
row through its installation. Do not repeat it in each row or mix contexts.
There are no OS, architecture, installation-channel, session, duration, exit-code,
argument, source URL, path, skill, username, machine-name, or free-text fields.

## Identity and authority

Use one identity per service origin, tool, local user profile, and execution
context. Share it across upgrades, project clones, native launches, and wrappers
of that tool. Different tools and CI runs get separate identities. Do not use
hardware/account fingerprints or infer cross-tool installation matches.
Repository identity remains global independently of installation scope.

Installation and batch IDs are lowercase RFC 9562 **UUIDv7**, with cryptographically
random remaining bits. Their embedded Unix millisecond timestamp is protocol
creation time, not invocation time. It is disclosed; UUIDs are not credentials.
The timestamp prevents an expired identity or batch from becoming a fresh first
submission after its finite replay records have been removed. Do not retimestamp
an ID or reuse it for a new operation.

After consent, generate a separate 256-bit CSPRNG token, encoded as 64 lowercase
hex digits. Supply it only in `Authorization: Bearer <token>` over HTTPS. It
allows registration, reports, and deletion for one installation, not admin access.
Never place it in a URL, body, argument, log, preview, or repository. The server
stores SHA-256 of UTF-8 `app-tracking-token-v1\n<installation_id>\n<token>` and
compares credentials without exposing values. No token refresh/recovery endpoint
or binary-embedded shared credential exists in v1.

Generate the identity just before the first online registration attempt, not
when offline consent is initially recorded. Persist identity, credential, and
registration declaration atomically before that attempt. Retain the same values
on an unknown outcome. No monthly rotation or silent reset is permitted. A
terminal conflict/expiry needs the explicit recovery in the consent policy.

Registration is a client declaration, not server proof that consent occurred,
a person exists, or the binary is authentic. A token holder can fabricate counts.

## HTTP envelope

| Method and exact path                        | Successful result                                                 |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `PUT /v1/installations/{installation_id}`    | `201 registered`, or `200 duplicate` for an identical declaration |
| `POST /v1/usage-batches`                     | `200 accepted` or `200 duplicate`                                 |
| `DELETE /v1/installations/{installation_id}` | Empty `204` after revocation and primary deletion commit          |

Registration and batch ingestion are implemented in the gated candidate; DELETE
remains issue #8. The production service remains version-only. All telemetry
responses, including errors, carry
`Cache-Control: no-store`; no telemetry route uses CDN cache or conditional GET.
No query strings, cookies, redirects, browser CORS permission, or arbitrary
upstream destinations are supported. The fixed user agent is
`app-tracking-telemetry-client`, without tool version or other custom headers.
Transport providers can still process IP addresses and connection metadata.

Registration and batches use UTF-8 JSON, `Content-Type: application/json`
(optionally `charset=utf-8`), without compression. Reject unknown fields, duplicate
JSON object keys, invalid UTF-8, trailing material, and non-JSON/nonfinite numbers.
Do not coerce strings, supply defaults, strip fields, or normalize an invalid
input into acceptance. DELETE has no body; the schema's `deletion: null` denotes
absence, not a JSON `null` request. Bound streamed bytes even without a declared
length. Request headers are bounded to 16 KiB. Success/error bodies are at most
2 KiB. Transport errors may have no JSON body; clients must handle status first.

Registration bodies contain `schema_version: 1`, `tool_id`, `consent_revision`,
`consented_at` (UTC with exactly three fractional digits), and `mode`.
`telemetry-v1` is the only supported consent revision. Tool, revision, context,
consent time, and credential are immutable for an installation. Renewed consent
uses a new identity; it cannot silently expand an existing registration.

Batch bodies contain `schema_version: 1`, `tool_id`, `installation_id`, `batch_id`,
`consent_revision`, and `rows`. The registration determines context. There is no
send-time field or optional version lookup: updates continue through the separate
public version client. A version/metrics outage cannot change a report receipt.

## Bounds and time

| Limit                 | v1 rule and reason                                                         |
| --------------------- | -------------------------------------------------------------------------- |
| Registration body     | At most 1,024 streamed bytes; the declaration is small                     |
| Batch body            | At most 65,536 streamed bytes, inclusive                                   |
| Rows                  | 1–256; bounded validation/transaction work                                 |
| Count                 | 1–1,000,000 per row; at most 10,000,000 per batch and installation/UTC day |
| First registration    | UUID creation time in `[now − 300 s, now + 300 s]`                         |
| Consent time          | Not later than `now + 300 s` or ID time + 300 s; not older than 90 days    |
| First batch           | UUID creation time in `[now − 7 days − 300 s, now + 300 s]`                |
| Usage days            | Seven UTC dates including today, with the midnight grace defined below     |
| Server request        | At most 3 s; no partial batch acceptance on timeout                        |
| Authenticated uploads | At most 10 attempts per rolling 60 s per installation; deletion is exempt  |

All instants use UTC; `now` is the authoritative server time sampled inside the
write transaction, not request arrival at a queue. Expiry comparisons are exact.
A calendar date must exist, including leap-year checks. For a new batch:

```text
UTC-date(now − 300 seconds) − 6 calendar days <= row.day
row.day <= UTC-date(now + 300 seconds)
row.day <= UTC-date(batch UUID creation time)
row.day >= UTC-date(registration.consented_at)
```

This adopts the proposed seven-day age as **seven UTC dates including the
current partial day**, rather than claiming sub-day accuracy. The five-minute
midnight grace can include one extra date at an edge. It accommodates small
clock differences; it does not permit indefinite offline backfill. Large skew
requires fixing the clock, not moving old counts to a new day or changing IDs.
UUID birth in the future by more than 300 s returns `clock_skew`; otherwise old
first batches return `batch_expired`, and invalid row dates return
`invalid_usage_day`. Duplicate receipts are resolved before these age checks.

The registration window applies only to a missing identity. An existing,
authenticated identical registration remains a duplicate until inactivity expiry.
At exactly 90 days since registration or the last **newly accepted** batch,
whichever is later, the authority expires. Duplicate batches, registration
replays, rejected traffic, and update checks never extend it. Expiry purges its
attributable state like deletion and requires a new explicit grant. A server
maintenance delay cannot make expired authority usable.

## Canonical payload and acknowledgement

Canonicalization version 1 is fixed for protocol v1:

1. Validate shape, ASCII field alphabets, real dates, SemVer, count bounds, and
   project-field pairing. Unknown fields are errors, not hash exclusions.
2. For each row, its dimension key is RFC 8785 JCS of the row with `count` omitted.
   Reject repeated dimension keys, even if the counts differ. The client must
   combine those counters before closing a batch.
3. Sort rows by the dimension key using byte order. Apply JCS to the entire
   validated batch with those sorted rows. Include every envelope field and
   count; do not include authorization, HTTP headers, or a hash field.
4. SHA-256 the UTF-8 canonical bytes, yielding lowercase hex. No newline, BOM,
   locale sorting, or server-time field is included. Values are ASCII strings
   and bounded positive integers, avoiding floating-point/Unicode ambiguity.

Whitespace, object-key order, integer spelling such as `1.0`, and row order do
not change meaning. Count, day, command, version, project, consent revision, or
identity changes do. A closed batch's identity and semantic payload never change.
Splitting is allowed only before first submission, with a distinct ID per batch.
Do not rechunk/re-ID a possibly committed batch after a timeout or lost response.

A batch acknowledgement contains schema version, installation ID, batch ID,
status (`accepted`/`duplicate`), `payload_sha256`, and the original server
`received_at`. On retry only status changes. A client removes only the matching
queued batch after verifying every echoed identity/hash and the response shape;
a malformed/mismatched `200` is an unknown outcome. New counters accumulated
while a batch was in flight remain separate. Duplicate acknowledgement does not
mean the original usage is still retained or restore deleted/expired rows.

## Atomic decision order and errors

After bounded transport/shape validation, serialize writes with the installation
row lock and a unique `(tool_id, installation_id, batch_id)` key:

1. Authenticate. Missing/wrong credentials return `401 unauthorized`, including
   known-ID credential conflicts. Unknown installation is `404 installation_not_found`.
2. Check revocation/inactivity. A correct old credential returns `410`; do not
   disclose receipt data or accept a replay for a revoked identity.
3. Require tool/revision to match the immutable registration. A changed
   registration is `409 registration_conflict`; a report's unsupported/mismatched
   revision is `409 consent_required`. Unsupported schema/tool is `400`.
4. Look up a live receipt. Same canonical hash returns `duplicate`; different
   hash returns `409 batch_conflict`. Resolve retained receipts even when a
   previously valid catalog value has since retired, using their v1 canonical
   rules. No new acceptance uses a retired value.
5. For a missing/expired receipt, enforce UUID/day/consent age, dimensional
   allowlists, uniqueness, and daily quota. Never treat receipt GC as a fresh
   grant of reporting authority.
6. Commit the receipt, all usage rows, daily quota, and last-activity update in
   one transaction, or commit none. Lock waits/dependency failure return `503`.

Deletion takes the same installation lock. If ingestion commits first, deletion
removes it before returning `204`. If deletion commits first, ingestion returns
`410`. Lost acknowledgements do not permit a second contribution. First
registration uses a unique installation key; a concurrent loser must re-read
and authenticate, not overwrite the winner.

Errors use `{ "schema_version": 1, "error": { "code": "..." } }`, without input,
credential, URL, upstream body, exception, or free-form detail:

| Status | Codes                                                                                                                                                  | Client action                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `400`  | `invalid_request`, `unsupported_schema`, `unsupported_tool`, `invalid_usage_day`, `batch_expired`, `clock_skew`, `duplicate_dimensions`, `count_limit` | Stop unchanged retries; inspect locally. Do not move counts to fresh dates/IDs  |
| `401`  | `unauthorized`                                                                                                                                         | Pause reporting; never replace another identity's credential                    |
| `404`  | `installation_not_found`                                                                                                                               | Pause and inspect; no automatic registration/reset                              |
| `409`  | `registration_conflict`, `batch_conflict`, `consent_required`                                                                                          | Stop unchanged retries; require explicit repair/consent as applicable           |
| `410`  | `installation_expired`, `installation_revoked`                                                                                                         | Stop collection/upload; clear unsent usage; retain only deletion/recovery state |
| `413`  | `payload_too_large`                                                                                                                                    | Stop unchanged retries; never split a batch with an unknown outcome             |
| `415`  | `unsupported_media_type`                                                                                                                               | Stop unchanged retries; repair the client                                       |
| `429`  | `rate_limited`                                                                                                                                         | Retry the same operation with bounded backoff                                   |
| `503`  | `service_unavailable`                                                                                                                                  | Unknown outcome: retry the same operation/ID                                    |

Unsupported methods return `405 method_not_allowed` with the route's `Allow`
header. Unknown paths return `404 not_found`. Encoded/malformed IDs, extra path
segments, query strings, fragments, or a nonempty DELETE body do not identify an
installation operation and are rejected without mutating state. These responses
also use the fixed error shape and no-store policy.

Valid `Retry-After` on 429/503 is an integer delta in `[60, 86400]` seconds;
clients clamp it to that range and combine it with their local backoff using the
later deadline. Missing/invalid headers use local backoff. A server-side quota
excess returns `count_limit` without partial acceptance. Gateway protection must
not depend on usage consent and must never manufacture a usage count; its
provider logging/limits need the operational evidence in issue #11.

DELETE accepts credentials regardless of consent revision. An authenticated
revoked record returns `204` again; no repeated deletion extends retention.
Unknown records return `404`; the client can record that no installation remains
in the active store, without claiming a fresh deletion took place. Empty 204 is
the only affirmative deletion acknowledgement. No unfinished asynchronous
work is represented as completed deletion; if bounded synchronous deletion
cannot pass issue #8, revise this contract before enabling it.

## Retry, replay, and expiry proof

Let `W = 7 days + 300 s`, `R = 90 days`, and `G = 300 s`.
First acceptance requires a batch birth within W and eligible occurrence days.
A receipt survives R after first receipt, without extending on replay. A first
receipt can precede the ID time by at most G, so `R > W + G` ensures that a batch
whose receipt has expired cannot pass first-acceptance birth validation again,
even if its row days were edited. Unchanged old rows also fail the day rule.
Retained receipts compare the full canonical hash before row-age validation.
The installation must still be active and authenticated; a duplicate receipt
never revives expired or revoked authority. Changing the batch ID is a different
operation, not a retry.

A revoked/expired identity keeps only a minimal tombstone for R. Before its
expiry it rejects registration/reporting; after its expiry the original UUID
is older than G (`R > 2G`, even for an initially future-skewed ID), so it cannot
pass first-registration validation. Changing `consented_at` cannot change that
embedded timestamp. Deletion and receipt GC therefore require no permanent
identifier blacklist during normal operation.
A provider restore rolls the database back, including these records; it is not
covered by a stronger historical-deletion guarantee. The retention policy names
that recovery boundary explicitly. Forging a new timestamped
ID and fresh counts is fabricated new input, which public-client tokens cannot
prevent; it is not an accepted replay or a valid population estimate.

| Path                                          | Required result                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lost registration response                    | Same ID/token/declaration yields duplicate; never overwrite credentials                               |
| Lost batch response / concurrent replay       | Unique claim and same hash yield one contribution                                                     |
| Changed contents under retained batch ID      | Conflict, no increment                                                                                |
| Receipt expires during an active installation | Old batch UUID fails W; no new count                                                                  |
| Deletion races a replay                       | Common installation lock gives deletion or revocation, never resurrection                             |
| Tombstone expires                             | Old installation UUID fails G; no reactivation                                                        |
| Backup restored                               | Restore one consistent provider snapshot; do not append or re-ingest its counts; see retention policy |

These are contract obligations, not a database-concurrency proof. Issues #6–#8
must test them against the actual runtime/database. Fixture-model tests do not
establish HTTP-driver transactions or production deletion.

## Compatibility and delivery order

The v1 canonical algorithm, existing field meanings, and consent revision never
change in place. Retain the validation vocabulary for existing receipts until
all of their 90-day retention windows end, even if a command category is retired
for first submissions. A new material purpose, payload dimension, or incompatible
meaning requires a new wire revision/route and affirmative consent; clients do
not negotiate broader consent automatically. Old credentials must continue to
support deletion independently of any ingestion-revision retirement.

A reviewed addition to the same disclosed command taxonomy is deployed to the
service/schema catalog before a consumer emits it. Older consumers continue to
send their existing categories or `other`. Fields are never silently dropped to
fit a consumer. Record an explicit migration/support plan before withdrawing an
accepted protocol; this contract does not declare a future retirement date.

## References checked 2026-10-23

- [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785): canonical JSON input to hashes.
- [RFC 9562 UUIDv7](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7): timestamp layout and random bits.
- [Issue #5](https://github.com/sebastian-software/app-tracking/issues/5): contract scope.
