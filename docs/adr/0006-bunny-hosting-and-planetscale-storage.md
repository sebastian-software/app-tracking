# ADR 0006: Bunny hosting and PlanetScale storage

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-23

## Context

The service needs inexpensive cached release delivery and durable handling of
usage reports, duplicate submissions, aggregation, and deletion. A cache alone
cannot enforce the reporting invariants. Existing Bunny deployments provide
relevant operational experience.

## Decision

I am using Bunny as the hosting platform and PlanetScale as the database
provider. Release responses use CDN caching; durable usage facts and
idempotency state live in the database. Cache contents are not authoritative
report receipts.

The version-only service uses one Bunny Edge Scripting deployment, updated
directly from main after automated checks. It needs no database, separate
staging environment, or manual promotion gate. This keeps initial operation
proportionate to a new service with no migrated consumers. Verified release
artifacts provide a straightforward rollback path.

For later telemetry, Bunny Edge Scripting with TypeScript and PlanetScale
Postgres is the proposed implementation in the RFCs. That combination must
pass an isolated integration proof before the runtime, driver version, database
tier, and region are finalized. This ADR
selects providers, not a claim that every advertised feature has been tested.

Public source contains design, application code, and non-secret configuration.
Credentials, private deployment details, and real telemetry remain outside the
repository. Test and production data and credentials are separate.

## Consequences

- The database is justified by reporting correctness, not by version checks.
- Deployment must explicitly configure caching, logging, secrets, access,
  regional processing, retention, and recovery.
- A chosen EU data region does not by itself establish that every processor,
  control-plane operation, backup, or support action remains in the EU.
- Provider cost and runtime limits must be checked against the chosen
  configuration and measured workload before rollout.
- A failed Edge/Postgres proof triggers a documented runtime decision, not an
  unreviewed additional database or compatibility service.

See [RFC 0003](../rfcs/0003-deployment-and-migration.md) for deployment and
validation gates.

## Changes

- 2026-10-23: Use one directly deployed version service; reserve isolated data
  and database integration checks for the later telemetry implementation.
