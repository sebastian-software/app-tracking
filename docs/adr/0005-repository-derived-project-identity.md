# ADR 0005: Repository-derived project identity

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-22

## Context

I want a repository used by several developers or clones to count as one
project. Directory and package names are ambiguous. Installation-specific salts
would prevent cross-installation counting, while a new committed UUID would
require project changes and could be copied unintentionally.

## Decision

Derive the identifier locally:

```text
project_id = SHA256(normalized_repository_url)
```

Prefer the checkout's Git `origin`. When it is absent, use the appropriate
`package.json.repository` string, object, or supported shorthand. An origin
that exists but cannot be normalized must not silently fall back to potentially
different package metadata.

Use one versioned normalization contract across tools. Do not add a tool ID,
installation-specific salt, or machine identifier to the hash. Send the
normalization version separately. Never transmit the original repository URL,
credentials, or filesystem path.

Equivalent supported SSH and HTTPS URLs produce the same identifier. A
monorepo is one project; `repository.directory` does not split it. Distinct
fork origins remain distinct. Unsupported or ambiguous identities are omitted
rather than guessed. Global commands can omit project identity entirely.

## Consequences

- Shared hashes enable project counting across tools and installations.
- Repository renames and moves change identity unless a later migration is
  explicitly designed. There is no inferred merge based on similar names.
- Known repository URLs can be hashed and matched. The identifier is
  pseudonymous, not guaranteed anonymous.
- The service cannot reconstruct missing project counts reliably and must
  expose the amount of usage without project identity.
- Normalization changes need compatibility fixtures and an explicit plan for
  identity continuity; a new algorithm version alone does not deduplicate old
  and new identities.

See [RFC 0002](../rfcs/0002-client-consent-and-measurement.md) for the proposed
normalization rules and boundary cases.
