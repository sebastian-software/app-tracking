# Telemetry retention and enablement: v1

This is the required policy for the future telemetry service. It does not assert
that a database, privacy notice, or deletion job is already deployed. Exact
constants live in [policy JSON](../contracts/telemetry-v1-policy.json), with
[wire semantics](telemetry-api.md) and [client disclosure](telemetry-consent.md).

## Data lifetime

The independent [functional service counters](service-statistics.md) retain
only aggregate day/route/response counts for 24 calendar months. They contain
no reporting identity, receive no client usage batch, and do not enter the
separately permitted monthly-history or publication features. Their read-time
expiry and bounded cleanup are implemented in migration 0013.

| Data                                | Visibility, expiry, and physical cleanup                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attributable usage                  | A row for day D expires at UTC start(D) + 90 days. Queries exclude it immediately; scheduled physical cleanup runs within 24 h                                                                                                                                      |
| Batch receipt                       | Original hash/IDs/receipt time survive 90 days after first receipt; never extend on retry. Remove within 24 h after expiry                                                                                                                                          |
| Active installation                 | Retained while active; expires exactly 90 days after registration or last new batch, whichever is later. It becomes unusable without waiting for cleanup                                                                                                            |
| Revocation/expiry tombstone         | Tool, ID, token hash, status/completion state, and original revoked/expired time only, for 90 days after that transition; no counters/project hashes. Remove within 24 h after expiry                                                                               |
| Consent declaration                 | Current revision/time/context while active; remove with active installation details. Retain no separate perpetual consent history                                                                                                                                   |
| Unsent local usage                  | Seven UTC dates plus clock grace, at most four MiB/64 batches/4,096 open dimensions; discard on withdrawal or veto                                                                                                                                                  |
| Pending local deletion              | Minimal credential/status for at most 90 days after withdrawal, unless acknowledged or explicitly forgotten earlier                                                                                                                                                 |
| Usage-derived views                 | Private maintainer queries compute from nonexpired attributable rows, without shared caching. No durable rollups or public usage exports are enabled; no usage series survives its sources                                                                          |
| Database backups/WAL                | Provider-managed, at most seven days for normal operation, including manual/protected copies. Not queried for reporting or exported to the repository                                                                                                               |
| App/CDN request logs                | Disabled; no payload, ID, hash, URL, credential, SQL parameter, or per-request application log                                                                                                                                                                      |
| Provider security/transport records | Not a measurement source. Follow the applicable provider agreement and published policy; no service-wide maximum is asserted for provider-internal records. Disclose verified product settings, unknown periods, and statutory/account-record exceptions separately |
| Bounded operational counters        | At most seven days, labels limited to tool/day/status category; no installation, project, IP, or payload labels. No anonymity claim                                                                                                                                 |
| Rate-limit state                    | Expires after 60 seconds for the authenticated rolling-minute window; scheduled physical cleanup within 24 h; no permanent IP-derived installation identity                                                                                                         |

The 90-day usage horizon supports rolling weekly/monthly measurements without
an indefinite repository/installation history. Seven dates of submission cover
ordinary offline/retry gaps; they deliberately lose older usage. Ninety-day
receipts outlive every first-submission window. Logical expiry is enforced in
reads and writes, not just by a nightly job. Physical cleanup can add at most
24 hours; backup expiry can add up to seven days after a retained copy is made.
The disclosure must distinguish these periods rather than promise all physical
copies disappear at the logical usage deadline.

Explicit deletion is stronger than ordinary expiry: revoke authority and remove
reporting visibility in the first committed request step. Bounded steps delete
primary usage, receipts, quota, and active installation details before returning 204. A larger pending purge returns 503 until complete; it never claims success
for unfinished work. The scheduled worker can resume it independently of traffic. Retain only the disclosed minimal tombstone and its pending/completed purge state. Repeating deletion
does not renew it. Another installation's contributions to the same repository
remain intact. Do not retain a deleted installation's quota, project lookup,
conflict payload, or materialized aggregate as an undisclosed alternate history.

## Ordinary provider recovery

Use PlanetScale's normal backup/PITR facilities. No custom restore service,
separate deletion-history store, or blanket telemetry-data purge is required.
A snapshot restores data and receipts together to one point; it is not a new
batch, an extra usage dataset, or a reason to add counts to the current totals.
Recompute any reporting view from that authoritative state, apply current
expiry rules, and describe the recovery-point gap in coverage. Do not merge
several snapshots or replay acknowledged reports under fresh batch IDs.

Restoring the database also rolls back deletions/revocations after the recovery
point. V1 does not promise an independently replayable historical-deletion
journal or claim that 204 edits immutable backups. Handle known deletion
requests through the normal deletion operation after recovery. The actual
backup retention, access/isolation, recovery handling, and rights notice must
be checked in issue #11 before enabling real telemetry. Short provider outages
normally use the client's retry/backoff path; they do not require a restore.

This is the explicit recovery boundary of the contract. The normal-operation
replay proof does not establish stronger deletion guarantees across an
operator-initiated database rollback.

## Evidence before real telemetry

The contract can be reviewed and implemented now. Enabling collection/reporting
in a released consumer requires the existing delivery gates, not a new staging
or promotion system:

- **#6, runtime/database proof:** Actual PlanetScale tier, EU database region,
  pinned HTTP driver, transaction/lock behavior, bounded request/deletion work,
  and verified backup configuration. A provider default is evidence to inspect,
  not evidence of the account's settings.
- **#7–#8, ingest/deletion:** Real concurrent registration, duplicate commits,
  lost acknowledgements, changed hashes, day/UUID expiry, tombstone GC, deletion
  races, read-time expiry, scheduled cleanup, and provider recovery boundary.
  Verify no access to another installation or admin data with a reporting token.
- **#10/#12, first client:** Affirmative current consent, no pre-consent state,
  one native invocation owner, wrapper deduplication, private atomic state,
  hard-veto/offline/CI precedence, withdrawal/offline deletion/reset, payload
  preview, bounded queues/latency, and measured live behavior with isolated
  synthetic data. Do not publish real reports as evidence.
- **#11, privacy/operations:** A released notice with the actual public
  controller/contact, purposes/legal bases, fields, rights, retention, processors,
  subprocessors, processing regions, and transfer safeguards. Review consent and
  terminal-device access under GDPR/TDDDG, the repository hash's guessability,
  employment/CI authority, and provider security records. Check applicable
  processor agreements, Article 28 terms and transfers where relevant; record
  the responsible review outcome without claiming that this document establishes
  compliance. GDPR erasure/access obligations are not replaced by a token-loss
  error or the automatic 90-day expiry.

Keep the evidence limited to public settings descriptions, revisions, synthetic
vectors, and pass/fail. Actual credentials, database/account/site IDs, internal
hosts, provider support material, and real telemetry stay private. The public
client notice links public processor information, not private deployment files.

A narrowly scoped operational gateway policy must bound anonymous registration
abuse before enablement; it must not store persistent IP-derived user identities
or treat gateway hits as usage. Its concrete provider limit and source-IP
security-record handling belong to #11's actual configuration, not an invented
cross-region rate guarantee in this contract. Authenticated upload limits are
specified in the wire contract. Deletion must remain accessible during an upload
quota failure. The [maintainer reporting contract](reporting.md) owns the
separately authorized private aggregate endpoint. Exact small cells are private
controller reporting, not anonymous/public exports. Separately permitted [monthly history](monthly-history.md) has a selected
24-month horizon and default-disabled persistence/public switches; #14 owns
public small-cell/cross-query disclosure decisions. Existing usage grants do not
include this additional scope. The 90-day detail policy is unchanged.

## Primary evidence checked 2026-10-23

- [EDPB consent guidance 05/2020](https://www.edpb.europa.eu/system/files/documents/files/file1/edpb_guidelines_202005_consent_en.pdf)
  informs the review of affirmative, informed, freely given consent and
  withdrawal. It does not validate a particular CLI flow.
- [Section 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html) addresses
  storage/access in terminal equipment and its exceptions; applicability and
  any exception for the actual operations need review.
- [Bunny processor information](https://bunny.net/gdpr/) identifies its DPA and
  subprocessor materials. Its general claims do not prove this service's logging
  or residency configuration.
- [Bunny logging](https://bunny.net/docs/cdn/logging) is an operational input;
  disabled application/CDN logs do not eliminate all infrastructure processing.
- [PlanetScale Postgres backups](https://planetscale.com/docs/postgres/backups)
  describes configurable schedules, two-day default retention, protected backups,
  and PITR. Verify every enabled schedule/WAL copy against the seven-day ceiling.
- [PlanetScale DPA](https://planetscale.com/legal/data-processing-addendum)
  (updated 2026-10-15) addresses processor roles, international transfers, and
  termination deletion. Its termination-backup deadline is not the chosen
  normal-operation retention policy or proof of an EU-only service.

These links establish review inputs, not unverified contractual commitments
about an existing account. Issue #11 records actual deployment/legal evidence.

The implemented [lifecycle runbook](telemetry-lifecycle.md) records deletion,
read-time visibility, authenticated scheduled cleanup, health, and the isolated
synthetic recovery proof. Public telemetry remains gated by issue #11.

## Provider-owned operational records

The service controls its reporting retention, backup policy, logging settings,
and any operational dataset it creates. It does not set Bunny's or PlanetScale's
internal security/account-record retention. `provider_security_max_days: null`
explicitly means no independently verified, universal provider-internal maximum;
it is not zero retention, permission for indefinite application reporting, or a
change to the 90-day/seven-day application and backup bounds. This metadata field
is not a wire field or a client retention rule.

The existing Bunny processor agreement is in place. Apply that agreement and
current provider policies, including transfer/subprocessor information, rather
than claiming that the agreement is an encryption switch or proves a numeric
internal log deadline. The application records no request-level logs, and
provisioning disables CDN access logs, permanent storage, and forwarding.
Bunny may still process transport metadata and internal security records.

PlanetScale [describes seven-day centralized Postgres log retention](https://planetscale.com/postgres).
The runtime's effective statement, slow-query, and sample logging are disabled;
error bind-parameter logging is zero. These settings were checked against the
actual runtime role. Product log retention does not establish the retention of
all provider-internal security or account records. Bunny's corresponding
internal maximum is not independently verified through the current dashboard.
Do not present either unknown period as zero or promise a universal 30-day cap.

Published sources checked on 2026-10-26:
[Bunny processor information](https://bunny.net/gdpr/),
[Bunny privacy policy](https://bunny.net/privacy/),
[Bunny subprocessors](https://bunny.net/gdpr/sub-processors/),
[PlanetScale Postgres](https://planetscale.com/postgres), and
[PlanetScale DPA](https://planetscale.com/legal/data-processing-addendum).
Review material provider changes against the notice; do not use their internal
records as an alternate reporting source.

## Separately permitted monthly summaries

The additive monthly-history implementation remains disabled pending its
released disclosure and risk assessment. When activated, only separately
permitted future observations can produce screened summaries retained for 24
months after month end. Additional permission metadata follows the active
reporting identity lifecycle. Withdrawal, deletion and expiry invalidate entire
potentially affected months; no contribution map survives the 90-day source
window. See the [full contract](monthly-history.md) for unavailable periods,
physical cleanup and recovery. This does not extend ordinary usage consent.

## Separately permitted shared profiles

Optional [profile linking](profile-linking.md) remains disabled pending its
released disclosure and assessment. Tool reporting IDs and their 90-day source
policy remain independent. The additional random shared ID/token hash and
monotonic linking choice follow active links; inactive/reset metadata expires
after 90 days, with scheduled physical cleanup within another 24 hours. No
profile identifier or overlap breakdown enters the public feed. A shared reset
removes links, while ordinary usage deletion remains tool-scoped.
