# ADR 0009: Private maintainer reporting

- Status: Accepted
- Date: 2026-10-27
- Last updated: 2026-10-27

Maintainers need cross-installation usage statistics without granting CLI
reporting credentials any analytics authority. Use a separate random read-only
maintainer key and separate database login for a fixed aggregate API on the
existing Bunny service. Only domain-separated key hashes enter runtime secrets;
the browser holds the plaintext key in tab memory. A login/account service is
unnecessary for this initial small maintainer audience, but key possession
grants all supported private aggregates and lacks individual attribution or MFA.

Compute results from the existing active, nonexpired usage view in a single
statement, bounded to 90 UTC dates and fixed tool/context/groupings. Count
distinct projects across tools and installations over the entire requested
period. Keep CI separate and distinguish absent observations from dependency
failure. Responses are private and never shared-cacheable. Read-time derivation
means committed deletion/expiry affects subsequent query snapshots immediately;
there is no alternate aggregate history to purge.

This deliberately retains the present 90-day limitation instead of introducing
unreviewed durable summaries. Query plans and fixtures establish an initial
read-time implementation; production volume can justify a later change.
Historical retention/anonymization and public exports require their own
documented boundaries. Exact API, enablement, rotation, recovery, and evidence
are in the [reporting guide](../reporting.md). Accepted records the direction,
not proof that credentials or production reporting are enabled.

## Change history

- 2026-10-27: Separate maintainer authority and compute bounded private usage
  statistics directly from retained reports.
