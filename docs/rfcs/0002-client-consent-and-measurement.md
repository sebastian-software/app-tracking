# RFC 0002: Client, consent, and measurement

- Status: Proposed
- Date: 2026-10-22
- Constraints: [ADR 0002](../adr/0002-independent-updates-and-opt-in-telemetry.md),
  [ADR 0003](../adr/0003-repository-derived-project-identity.md)

## Shared client boundary

I propose a reusable Rust client as the first implementation for Dalo and
Palamedes, with a runtime-independent wire contract. Sharing a library must not
force one tool's installation-channel policy, command names, or output behavior
on another. Additional runtimes can implement the same protocol later.

The shared layer owns consent-aware reporting state, version comparison,
throttling, counters, immutable batches, transport limits, and repository
normalization. The host tool supplies its identity, version, distribution,
command classification, project context, and presentation of update guidance.

Only the designated CLI entry point reports an invocation. npm wrappers,
native binaries, and embedded library use must not all count the same command.
Library consumers do not report automatically merely because they import code.

## Consent lifecycle

The initial states are undecided, declined, enabled for a documented consent
revision, and withdrawn. Until enabled, create no telemetry identifier, usage
counter, project hash, reporting queue, or telemetry network request. Version
checks remain an independently configured operation.

A disclosure must identify the operator, purposes, fields, endpoints, retention,
cross-installation project matching, relevant processors, withdrawal, and
deletion. It must explain that repository hashes can be matched against guessed
URLs and that installation counts do not count people.

Provide inspectable settings and a payload preview that sends nothing.
Credentials are redacted in previews. A new purpose or materially expanded
collection requires an appropriate new consent decision; do not silently
reinterpret an old consent revision.

Noninteractive execution cannot manufacture consent. An explicit configuration
mechanism may express a prior decision, but its scope and precedence must be
documented. CI reporting is initially excluded unless separately enabled and
classified. JSON or agent-driven invocations can contribute after consent;
non-TTY output alone is not evidence that an agent ran the command.

Withdrawal immediately stops local collection and upload and clears unsent
usage. Remote deletion is a separate authenticated operation. If offline,
explain that deletion is pending and retain only the state needed to request it;
do not resume usage collection while waiting. Resolve deletion-token loss and
identity reset behavior before publishing the consent UX.

Preserve existing explicit disable choices during migration, including
`DALO_UPDATE_CHECK=never`, `PALAMEDES_UPDATE_CHECK=0`, and `DO_NOT_TRACK=1`.
An offline override disables both network paths. No legacy behavior implies
consent to this protocol.

## Cadence and process lifetime

Start with a successful version-check interval of one hour during tool use.
There is no polling while idle. Track failures separately with bounded retry
suppression. Show an update notice at a useful frequency rather than on every
check, and never change the command's stdout or exit status on network failure.

Count invocations locally and normally upload at most daily while the tool is
used, with a separate bounded retry policy. A single report can contain several
UTC days and projects. Record usage by its occurrence day, not its receipt day.

Counters, check claims, queue limits, and batch closure must be atomic across
concurrent local processes. Closing a batch moves a snapshot into an immutable
queue; new invocations accumulate separately. Acknowledging a batch removes
only that batch, not counts created while it was in flight.

A detached in-process thread cannot promise to finish after a short CLI exits.
The execution mechanism remains open: compare a bounded join with a short-lived
upload subprocess, including latency, process cleanup, and reliable credential
handling. A permanent daemon is out of scope. Do not promise lossless telemetry:
offline expiry, uninstall, and the last unuploaded activity can remain missing.

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

| Input | Expected relationship |
| --- | --- |
| `git@github.com:example-org/example-project.git` | Same identity as the HTTPS form below |
| `https://github.com/example-org/example-project.git` | Canonical input `github.com/example-org/example-project` |
| `https://github.com/example-org/example-project/` | Same identity as the supported clone forms |
| `https://github.com/another-org/example-project.git` | Distinct project |
| Same repository with different `repository.directory` values | One project |
| Worktree and primary checkout sharing origin | One project |
| Local-only directory or unresolved SSH alias | No project identity |

Hash the canonical UTF-8 input with SHA-256, with no installation salt or tool
prefix. Include the normalization version beside the resulting hash. Different
normalization versions must not be silently assumed comparable. Rename/move
continuity and any future cross-version mapping require a separate design.

## What the measurements mean

| Measurement | Definition | Important limit |
| --- | --- | --- |
| Reported invocations | Sum of accepted invocation counts in the period | Can miss offline, expired, and unconsented usage |
| Active reporting installations | Distinct participating installation identities with usage in the period | Shared profiles and identity resets affect the count |
| Active reporting projects | Distinct known repository identities with usage in the period | Missing metadata and repository moves affect the count |
| Command distribution | Counts by allowlisted command | Not command arguments or user intent |
| Version adoption | Reported usage and installations by tool version | Not all installed copies, including inactive ones |

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

## Proposed retention and retry limits

These are starting proposals, not accepted policy or provider guarantees:

| Data or operation | Starting proposal |
| --- | --- |
| Age of usage in a first submission | At most seven days, with exact UTC boundary and clock-skew handling to be specified |
| Attributable usage rows and batch receipts | 90 days; receipts must cover every accepted retry/replay path |
| Local unsent queue | Bounded age and size; remove on withdrawal |
| Installation credential and identity | No automatic monthly rotation; lifetime and inactivity expiry remain open |
| Revocation records and deletion history | Minimum needed for replay prevention and backup recovery; exact period open |
| Backups, infrastructure logs, and derived aggregates | Explicit provider/configuration-specific policies before production |

An accepted duplicate can return its existing receipt while that receipt is
retained. Once receipts expire, an old payload must still fail the usage-age
rule; changing the envelope's send time cannot make old usage current.

Deletion must cover attributable tables, derived views, caches, and restoration
procedures. Do not describe a small or linkable aggregate as anonymous merely
because the original rows were removed. Longer-term aggregates and public
small-cell suppression need a separate disclosure analysis.

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
- A published consenting client is observed through the complete staging path.

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
