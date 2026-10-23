# RFC 0002: Client, consent, and measurement

- Status: Proposed
- Date: 2026-10-22
- Constraints: [ADR 0004](../adr/0004-independent-updates-and-opt-in-telemetry.md),
  [ADR 0005](../adr/0005-repository-derived-project-identity.md)

## Shared client boundary

The implemented [Rust update client](../rust-client.md) supplies version checks
for Dalo and Palamedes through a runtime-independent wire contract. The telemetry
client lifecycle below remains proposed. Sharing a library must not
force one tool's installation-channel policy, command names, or output behavior
on another. Additional runtimes can implement the same protocol later.

The shared layer owns consent-aware reporting state, version comparison,
throttling, counters, immutable batches, transport limits, and repository
normalization. The host tool supplies its identity, version, distribution,
command classification, project context, and presentation of update guidance.

Only the designated CLI entry point reports an invocation. npm wrappers,
native binaries, and embedded library use must not all count the same command.
Library consumers do not report automatically merely because they import code.

## Consent, reporting, and process lifetime

The maintained [telemetry API](../telemetry-api.md),
[client consent](../telemetry-consent.md), and
[retention policy](../telemetry-retention.md) settle the v1 contract from issue #5.
They own exact schemas, limits, per-tool/context identity, consent precedence,
CI opt-in, disclosure, withdrawal/offline deletion/reset, retry, and retention.
Telemetry is still unimplemented and disabled. The existing Rust crate only
performs update checks; these documents do not change it.

The client executes at most one bounded synchronous telemetry request per
invocation after command work. There is no detached upload worker, subprocess,
or permanent daemon. Version checks remain independent, with their existing
[client contract](../rust-client.md). Server and client implementation still need
real concurrency, queue, transport, and latency evidence in the adoption issues.

## Repository identity

Resolve project context only for consenting reporting. A global operation need
not have a project. A missing or rejected identity does not discard otherwise
valid usage; it contributes to the explicitly unknown-project category.

The proposed lookup order is Git `origin`, then `package.json.repository` only
when origin is absent. Support documented string/object forms and explicit
package-manager shorthand. Select the package associated with the tool's
project context rather than an arbitrary dependency package. A present but
unsupported origin must not silently become a different upstream project via
package metadata.

Normalization version 1 should:

- Parse supported clone URLs and SCP-style SSH syntax structurally.
- Strip user information and credentials before constructing the canonical
  identity; never log the input, including on errors.
- Normalize host casing and known provider aliases. Normalize path casing only
  where the provider's repository semantics support it.
- Unify supported SSH and HTTPS identities for the same provider/repository.
- Remove supported clone suffixes and trailing separators without collapsing
  distinct generic-host paths.
- Handle ports, queries, fragments, escaping, and aliases with explicit rules.
  Do not blindly remove distinctions that a self-hosted server can use.
- Reject local paths, unresolved SSH aliases, encoded path ambiguities, and
  unsupported inputs rather than using a directory name as a fallback.
- Perform no network request to identify or resolve a private repository.

Illustrative canonicalization fixtures, to become executable before release:

| Input                                                        | Expected relationship                                    |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `git@github.com:example-org/example-project.git`             | Same identity as the HTTPS form below                    |
| `https://github.com/example-org/example-project.git`         | Canonical input `github.com/example-org/example-project` |
| `https://github.com/example-org/example-project/`            | Same identity as the supported clone forms               |
| `https://github.com/another-org/example-project.git`         | Distinct project                                         |
| Same repository with different `repository.directory` values | One project                                              |
| Worktree and primary checkout sharing origin                 | One project                                              |
| Local-only directory or unresolved SSH alias                 | No project identity                                      |

Hash the canonical UTF-8 input with SHA-256, with no installation salt or tool
prefix. Include the normalization version beside the resulting hash. Different
normalization versions must not be silently assumed comparable. Rename/move
continuity and any future cross-version mapping require a separate design.

## What the measurements mean

| Measurement                    | Definition                                                              | Important limit                                        |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Reported invocations           | Sum of accepted invocation counts in the period                         | Can miss offline, expired, and unconsented usage       |
| Active reporting installations | Distinct participating installation identities with usage in the period | Shared profiles and identity resets affect the count   |
| Active reporting projects      | Distinct known repository identities with usage in the period           | Missing metadata and repository moves affect the count |
| Command distribution           | Counts by allowlisted command                                           | Not command arguments or user intent                   |
| Version adoption               | Reported usage and installations by tool version                        | Not all installed copies, including inactive ones      |

Deduplicate installations and projects across the whole requested period.
Adding daily distinct counts does not produce weekly or monthly distinct
counts. Multiple developers on one repository count as one project while all
their accepted invocations contribute to usage.

Keep local and explicitly enabled CI usage distinguishable. Do not infer
human-versus-agent use from terminal presence. Report how much usage has no
project identity. Cross-tool project counts are possible because project IDs
share a contract; cross-tool installation counts need an explicit identity
scope and are not implied.

Opt-in bias, multiple devices, shared profiles, copied environments, lost state,
late reports, deletion, and spoofed clients limit inference. Even complete
server collection covers only the reporting population. No number is labeled
unique users, people, or total adoption without independent supporting evidence.

## Accepted v1 retention and retry policy

The [retention policy](../telemetry-retention.md) and
[wire contract](../telemetry-api.md) replace the initial seven-day/90-day and
64 KiB/256-row proposals with exact adopted rules and rationale. Do not use this
RFC as a second copy of numeric values. Ordinary provider recovery restores one
consistent snapshot, not new usage; there is no separate deletion-history store
or blanket purge. The policy documents the database-rollback boundary explicitly.

## Excluded collection

Do not collect raw repository/source URLs, local paths, command arguments,
usernames, machine names, skill names or contents, arbitrary errors, source
code, or free-form logs. OS/architecture, distribution, session IDs, timing,
and finer feature dimensions require an explicit question they answer before
joining the initial payload. Transport-visible IP addresses are a separate
infrastructure concern, not made absent by omitting an IP field.

## Acceptance evidence

- No telemetry state, collection, or transmission before consent or after withdrawal.
- Identical hashes for supported equivalent URLs across tools and clones;
  distinct forks remain distinct and secrets never appear in diagnostics.
- Exactly one invocation counted through an npm/native wrapper chain.
- Concurrent counters, batch closure, replay, and partial failures do not
  double-count or erase new local usage.
- Short commands, JSON output, offline mode, CI exclusion, and disabled checks
  retain the host tool's behavior and tested latency budget.
- Weekly/monthly distinct counts, unknown-project usage, late arrival, and
  deletion have real database fixtures rather than sums of daily unique counts.
- A published consenting client is observed against the service with isolated
  synthetic data and credentials; no separate staging deployment is required.

## Prior art and review inputs

These are comparative inputs, not authorization to copy another tool's policy:

- [Next.js project identity](https://github.com/vercel/next.js/blob/canary/packages/next/src/telemetry/project-id.ts)
  and [storage](https://github.com/vercel/next.js/blob/canary/packages/next/src/telemetry/storage.ts).
- [Angular CLI analytics](https://angular.dev/cli/analytics).
- [Go telemetry](https://go.dev/doc/telemetry).
- [Homebrew analytics](https://docs.brew.sh/Analytics).
- [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng),
  [Section 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html), and
  [EDPB Guidelines 2/2023](https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en)
  for review of the concrete consent, update-only, and deployment design.
