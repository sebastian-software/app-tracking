# ADR 0007: MIT or Apache-2.0 licensing

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-22

## Context

The shared service and future client code need an explicit license before
publication. Dalo and Palamedes use `MIT OR Apache-2.0`; matching that choice
keeps the reusable code's licensing consistent across these projects.

## Decision

I license app-tracking under MIT or Apache-2.0, at the recipient's option.
The authoritative terms are [LICENSE-MIT](../../LICENSE-MIT) and
[LICENSE-APACHE](../../LICENSE-APACHE). Package metadata uses the SPDX
expression `MIT OR Apache-2.0`.

Third-party code keeps its own license. Bundled dependencies retain their
required notices; the Bunny SDK notice is recorded in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) and included in the
deployment bundle.

## Consequences

- Consumers have the same license choice as in Dalo and Palamedes.
- Distribution must preserve the applicable license texts and notices.
- Dependency upgrades and reused code require checking their own terms; this
  decision does not relicense third-party code.

## Change history

- 2026-10-22: Selected dual licensing before the first implementation release.
