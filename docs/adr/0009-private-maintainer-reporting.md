# ADR 0009: Private maintainer reporting

- Status: Accepted
- Date: 2026-10-27
- Last updated: 2026-10-27

Maintainers need cross-installation usage statistics without granting CLI
credentials any analytics authority. Use WorkOS AuthKit for personal sign-in
and require the configured application organization plus `reporting:read` on
every aggregate request. Keep a separate aggregate-only database login. Hosted
AuthKit owns identity, recovery and configured MFA/passkeys; app-tracking owns
its callback, encrypted HTTP-only cookie, signature/issuer/client/expiry checks,
and the final authorization decision.

The initial shared-key prototype in this unmerged feature is replaced entirely.
A shared secret provides no personal identity or account lifecycle, while WorkOS
is the intended reusable identity provider. OAuth state and PKCE bind callbacks
to a short-lived server-encrypted cookie. Tokens stay outside page JavaScript
and browser storage; no maintainer account/session table is added to PlanetScale.
Refresh preserves the eight-hour maximum session and rechecks permissions.
Short-lived access tokens bound the delay before access changes take effect;
provider verification outages fail closed without clearing valid local state.
Version delivery and CLI consent remain independent of this login system.

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
  statistics directly from retained reports. Replace the initial key prototype
  with WorkOS AuthKit, explicit organization/permission checks, and sealed sessions.
