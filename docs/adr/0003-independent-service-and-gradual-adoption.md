# ADR 0003: Independent service and gradual adoption

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-23

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

The new service is shared across tools. It owns the version API, release
eligibility, usage-report ingestion, and usage aggregation. Version data comes
from the existing CDN-cached oss-metrics snapshot; oss-metrics remains the owner
of GitHub release discovery. app-tracking does not maintain duplicate registry
or GitHub lookups. `oss-metrics` can also consume approved public usage aggregates.

All installation methods share the tool's GitHub release version. A one-hour
minimum release age allows downstream package publication to catch up; it does
not guarantee package-manager readiness. Hosts retain installation-aware
upgrade instructions. The [version contract](../version-api.md) owns canonical
routes, aliases, timestamps, cache behavior, and unavailable results.

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

## Change history

- 2026-10-23: Reuse oss-metrics for release data instead of duplicating discovery.
  Use one GitHub release version across installation methods, with a one-hour
  minimum age to reduce downstream publication races.
