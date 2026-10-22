# ADR 0001: Independent service and gradual adoption

- Status: Accepted
- Date: 2026-10-22

## Context

`version-service` already combines update checks with aggregate analytics.
`oss-metrics` publishes cached public metrics. Their existing contracts differ
from the new requirement for independent update checks, opt-in reporting, and
shared repository identity. Extending or merging them would bring those
contracts into the new service's initial implementation.

## Decision

I am starting app-tracking as an independent repository, API, and deployment.
The existing projects provide evidence and design inspiration. They are not
the compatibility contract or required code structure of this service.

The new service is shared across tools. It owns release discovery, usage-report
ingestion, and usage aggregation. `oss-metrics` can consume approved public
aggregates while retaining its broader public OSS-metrics role.

Tools adopt the new client contract one at a time, starting with Dalo in the
proposed rollout. A migrated invocation uses only the new update/reporting
path. Old published clients continue using their existing services until a
separate retirement decision is supported by adoption evidence.

## Consequences

- The new service needs no legacy `/check` route or Rybbit compatibility layer.
- The existing services and clients are not changed by creating this repository.
- Two generations of version delivery coexist during migration. Each has a
  clear owner; the new service still has only one internal release-data path.
- Historical update-check counts and new opt-in usage measurements remain
  separate series with different meanings.
- Server-side rollback must not silently send a migrated client back to
  automatic legacy analytics.

See [RFC 0003](../rfcs/0003-deployment-and-migration.md) for adoption evidence
and retirement conditions.
