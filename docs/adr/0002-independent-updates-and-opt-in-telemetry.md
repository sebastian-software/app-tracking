# ADR 0002: Independent updates and opt-in telemetry

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-22

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

The service uses the same release metadata for version-only requests and
optional release information in telemetry responses. Sharing a response does
not couple the success of the two operations.

## Consequences

- There are separate public read and consent-dependent write paths.
- A telemetry outage does not prevent cached version delivery.
- Reports measure the participating population, not all users or people.
- Disclosure, consent revision, retention, deletion, and infrastructure
  metadata handling are part of the design, not an anonymity claim.
- The final legal basis and operator obligations require review of the actual
  deployment; this decision does not certify compliance.

See [RFC 0002](../rfcs/0002-client-consent-and-measurement.md) for the client
lifecycle and measurement boundaries.
