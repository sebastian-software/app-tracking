# ADR 0004: Independent updates and opt-in telemetry

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-23

## Context

Update checks answer which release is available. Usage measurement answers how
often consenting installations invoke a tool and which features they use.
Counting update requests as usage couples consent, request frequency, and
availability, and cannot establish distinct installations across days.

## Decision

I am keeping update checks and usage reporting independently configurable.
Version information is available without telemetry consent or reporting
identifiers. An update check must not become a substitute usage event when
telemetry is declined.

Telemetry requires explicit opt-in before usage counters, reporting identity,
or project identity are collected for this purpose. Consent covers documented
fields and purposes. Existing opt-out-based reporting does not establish
consent to the new protocol.

The client summarizes usage locally and sends bounded batches. Withdrawal
stops collection and upload, clears pending reports, and provides a way to
delete retained attributable data. Offline and disable controls remain explicit.

Each tool/user-profile/context has its own consented installation identity;
repository hashes remain shared across tools and clones. CI is separately
opt-in. Identity changes require an explicit reset or renewed grant, not an
automatic reporting retry. The client uses finite-lived immutable operation
identities and durable receipts to bound replay state instead of retaining a
permanent identifier blacklist. UUID creation time is disclosed protocol
metadata, not a per-invocation timestamp.

The maintained [telemetry API](../telemetry-api.md),
[consent policy](../telemetry-consent.md), and
[retention policy](../telemetry-retention.md) define v1 fields, finite windows,
recovery behavior, and conformance vectors. Reports have no bundled version
lookup in v1; updates use their independent public client.

Use normal PlanetScale recovery without a separate deletion-history store or
blanket telemetry purge. A backup restores one dataset, not additional usage.
The retention policy explicitly scopes the consequences of rolling back
acknowledged database changes; no stronger restore-time deletion guarantee is
implied. Actual processor/legal and runtime evidence belongs to the existing
production-enablement issues, not to this contract's acceptance.

## Consequences

- There are separate public read and consent-dependent write paths.
- A telemetry outage does not prevent cached version delivery.
- Reports measure the participating population, not all users or people.
- Disclosure, consent revision, retention, deletion, and infrastructure
  metadata handling are part of the design, not an anonymity claim.
- The final legal basis and operator obligations require review of the actual
  deployment; this decision does not certify compliance.

See [RFC 0002](../rfcs/0002-client-consent-and-measurement.md) for shared-client
boundaries and the remaining repository-normalization proposal.

The proposed [metric and consent assessment](0010-metrics-purposes-and-consent.md)
separates functional service statistics, necessary protection, and additional
CLI reporting. It does not change this accepted opt-in decision.

## Change history

- 2026-10-23: Define per-tool/context identity, separately opted-in CI, finite
  replay protection, explicit renewal/reset, and the maintained v1 contracts.
  Keep provider recovery proportionate: no separate deletion history or blanket
  purge, and no claim that a database rollback preserves later deletions.
