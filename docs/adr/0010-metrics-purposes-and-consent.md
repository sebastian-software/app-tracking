# ADR 0010: Metrics, purposes, and consent assessment

- Status: Accepted
- Date: 2026-10-27
- Last updated: 2026-10-29
- Evidence reviewed: 2026-10-29

## Context

I want the greatest useful understanding of adoption, features, environments,
and service demand, with the widest supportable measurement without prior
consent. I accept defensible legal gray areas; I do not accept clearly unlawful
collection. Uncertainty is a risk to assess, not an automatic opt-in rule.
A local CLI invocation, an internal tool invocation, a catalog loaded
from disk, and a download from an operated service are different observations.
They need different definitions and assessments.

This record is a working assessment for a German operator serving an
international audience. The classifications below are engineering judgments
based on the cited primary sources, not field-specific rulings or legal
clearance. They depend on the actual purpose, implementation, and jurisdiction.
French audience-measurement guidance is useful comparative evidence, not a
German exemption ([E8](#e8-french-audience-measurement-exemption)).

The [consent contract](../telemetry-consent.md) still governs attributable CLI
reporting. The selected no-consent service path is implemented separately;
its [contract](../service-statistics.md) owns its scope and deployment switch.
This decision does not claim that all local counters require consent or switch
existing rich events to baseline collection.

## Decision

Classify each observation by its source and purpose before choosing a control:

1. **Service statistics:** maximize aggregate observations from otherwise lawful,
   functional version and download requests. Offer a documented opt-out from
   optional analytics. Assess the legal basis for the processing that precedes
   aggregation, including transient IP processing.
2. **Service protection:** use only the identifiers and counters justified by
   actual access control, quotas, or abuse prevention. Explain them separately;
   declining optional analytics does not automatically disable necessary
   protection when using the online service.
3. **Product usage reporting:** retain explicit opt-in for attributable local
   command, component, catalog, and environment observations. Investigate the
   narrowly defined identifier-free invocation counter separately.

For each candidate, identify the information gained, concrete acquisition path,
strongest argument for no-consent collection, contrary evidence, and remaining
risk. Prefer a useful narrower default-on design over placing the whole
observation behind consent. No universal rule makes OS names, counters, or CI
intrinsically consent-dependent: source, purpose, and implementation decide the
assessment. An unresolved question is not a court finding that collection is
prohibited. Risk acceptance does not create an exception to an applicable law.

The selected implementation records S01 and version-response categories from
S05 directly on the server, with immediate aggregation and an effective opt-out.
S02-S04 remain opportunities at the actual resource-serving system; an extra
client download report is a different observation. S06 needs its own IP-purpose
assessment. No visitor estimate or device collector is added to this path.

An opt-out is a control, not a legal basis. Access to information on a device
and subsequent personal-data processing need separate assessments
([E1](#e1-terminal-access-law), [E2](#e2-gdpr), [E3](#e3-german-supervisory-guidance)).
Hashing, local preprocessing, or keeping counters only in RAM does not by
itself remove the device-access question
([E5](#e5-technical-scope-of-device-access)).

## Classification key

| Classification      | Meaning for the exact design in the row                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No-opt-in candidate | A defensible design based on functional service requests and limited processing. Document the purpose, applicable basis, transparency, processors, and minimization before enabling it. |
| Conditional         | A possible exception or lawful basis depends on facts still to establish, such as actual necessity, effective protection, or the balancing assessment.                                  |
| Unresolved          | A gray-area candidate needing an explicit assessment of competing arguments and accepted risk before activation; this classification is not a prohibition.                              |
| Opt-in              | The selected current design requires an informed affirmative grant before additional local reporting. This is not a universal statutory whitelist or blacklist of field names.          |
| Excluded            | Not part of the proposed collection scope; consent alone does not establish necessity or justify unlimited collection.                                                                  |

The field names and bucket examples below describe candidate semantics. The
[wire contract](../telemetry-api.md) remains authoritative for implemented
fields; these tables are not an alternative schema.

## Metric matrix

### Functional online requests

| ID / metric                       | Exact observation and constraints                                                                                                                                                                                    | Classification                                             | Evidence                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S01 Version requests              | Server UTC day, reviewed tool ID, distribution label, release channel, and request count. No installed version, device query, or persistent visitor ID. Implemented as origin-only counts; CDN coverage is separate. | No-opt-in candidate                                        | [E3](#e3-german-supervisory-guidance), [E4](#e4-server-side-measurement-example) |
| S02 Syntax downloads              | Requested public syntax ID, artifact version, format, request count, and bytes transferred. Aggregate existing requests; omit arbitrary URLs, query strings, credentials, and client history.                        | No-opt-in candidate                                        | [E2](#e2-gdpr), [E4](#e4-server-side-measurement-example)                        |
| S03 Download platform             | OS/architecture category from the requested artifact variant, such as `macos-aarch64`. Measures artifact selection, not detected hardware or the running OS version.                                                 | No-opt-in candidate                                        | [E4](#e4-server-side-measurement-example)                                        |
| S04 Remote catalog/index requests | Reviewed public catalog/package ID, version, format, and server request count. No private catalog names or user-supplied catalog URL labels.                                                                         | No-opt-in candidate                                        | [E3](#e3-german-supervisory-guidance), [E4](#e4-server-side-measurement-example) |
| S05 Service quality               | Aggregated status categories, response-time distributions, cache hits/misses, and bytes. Measure at the serving system; do not attach a client identifier or instrument local work.                                  | No-opt-in candidate                                        | [E2](#e2-gdpr), [E4](#e4-server-side-measurement-example)                        |
| S06 Country distribution          | Derive country from an already available request IP and immediately increment a country counter. No raw IP, city, coordinates, or geography-based visitor identity in the statistics.                                | Conditional: separately assess purpose and proportionality | [E2](#e2-gdpr), [E4](#e4-server-side-measurement-example)                        |

### Local usage and environment

| ID / metric                               | Exact observation and constraints                                                                                                                                                                                                                                                   | Classification                              | Evidence                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| U01 Minimal invocation counter            | A separate CLI request containing only reviewed product/command categories and tool version; no installation/project ID, device fields, persistent usage queue, or cross-request linkage. A distinct proposal, not a claim that the existing batch client is exempt.                | Unresolved                                  | [E3](#e3-german-supervisory-guidance), [E5](#e5-technical-scope-of-device-access)                                                       |
| U02 Attributable command usage            | UTC day, host tool/version, allowlisted command category, count, and reporting installation ID; optionally project identity. One native entry-point invocation, no argv or paths.                                                                                                   | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access), [ADR 0004](0004-independent-updates-and-opt-in-telemetry.md) |
| U03 Component tool usage                  | A separate count of an explicitly dispatched component or plugin under a host such as Palamedes. Only reviewed public component/operation IDs; custom namespaces become `other`. Never send executable paths or arbitrary manifest/command names.                                   | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U04 Local catalog loads                   | Count successful catalog resource loads, summarized by command and reviewed format (`po`, `fcl`, `other`). Record neither message content nor catalog names, paths, tenant names, or their hashes. Distinguish process loads from logical resources and remote downloads.           | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U05 Installed-version adoption            | Tool version from U02; report invocation-weighted and installation-weighted distributions separately. A downloaded version is not evidence of an active installed version.                                                                                                          | Opt-in; inclusion in U01 remains unresolved | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U06 Active installations                  | Distinct random reporting IDs per tool/profile/context over the complete requested period. No OS machine ID or hardware-derived fingerprint. Installation counts are not people or physical-machine counts.                                                                         | Opt-in                                      | [E1](#e1-terminal-access-law), [ADR 0004](0004-independent-updates-and-opt-in-telemetry.md)                                             |
| U07 Active repositories                   | SHA256 of the normalized repository URL, with normalization version; same repository across clones/tools, distinct fork origins separate. Never send the URL. Known URLs can be matched, so the hash is pseudonymous, not guaranteed anonymous.                                     | Opt-in                                      | [E1](#e1-terminal-access-law), [ADR 0005](0005-repository-derived-project-identity.md), [project contract](../project-identity.md)      |
| U08 OS family and executable architecture | Bounded OS category and executable architecture, such as `macos` and `aarch64`. Under emulation, executable architecture may differ from physical CPU architecture. Collected locally for reporting, unlike S03.                                                                    | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U09 OS version                            | Normalized numeric macOS product version, Linux kernel release, or Windows kernel/build version. No hostname or custom build suffix; use `unknown` when unavailable.                                                                                                                | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U10 CPU family                            | Reviewed categories such as `apple_m1`, `apple_m4`, `intel`, `amd`, `other`, `unknown`. Apple generation and x86 vendor are different resolutions; do not claim an Intel/AMD generation from a vendor label.                                                                        | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |
| U11 Capacity                              | Optional future buckets: logical cores `<=4/<=8/<=16/>16`; RAM `<=8/<=16/<=32/<=64/>64 GiB`, plus `unknown`. No exact hardware inventory. Not part of the current wire contract.                                                                                                    | Opt-in                                      | [E1](#e1-terminal-access-law), [E2](#e2-gdpr)                                                                                           |
| U12 Execution context                     | Coarse local/CI and, if separately adopted, container categories. Never transmit runner/job names, provider account IDs, or environment contents. Attributable CI reporting needs an explicit operator grant; functional service statistics apply equally to local and CI requests. | Opt-in                                      | [E1](#e1-terminal-access-law), [E6](#e6-consent-design), [consent contract](../telemetry-consent.md)                                    |
| U13 Local performance/results             | Duration buckets, success/error counts, and reviewed diagnostic codes. No free-form error text, stack traces, logs, source, or dumps. Distinct from S05 server observations.                                                                                                        | Opt-in                                      | [E1](#e1-terminal-access-law), [E5](#e5-technical-scope-of-device-access)                                                               |

### Protection and identifiers

| ID / purpose                  | Exact observation and constraints                                                                                                                                                                                                           | Classification             | Evidence                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| A01 Access/abuse token        | Credential scoped to the operated service, with bounded quota counters and revocation where needed. Establish why this mechanism is effective and necessary; limit credential issuance as well as use. No product-history reuse by default. | Conditional without opt-in | [E1](#e1-terminal-access-law), [E2](#e2-gdpr), [E3](#e3-german-supervisory-guidance)                |
| A02 IP-based protection       | Purpose-limited request limits, attack detection, and proportionate blocks. Define counter windows, block review/expiry, and retention for the actual mechanism; no permanent IP-derived reporting identity.                                | Conditional without opt-in | [E2](#e2-gdpr), [E7](#e7-contract-necessity-and-service-improvement)                                |
| A03 Project entitlement/quota | Server-verified project entitlement and quota usage, only if the service actually grants access or capacity per project. A client-supplied repository hash is not proof of entitlement and must not let an attacker block another project.  | Conditional without opt-in | [E1](#e1-terminal-access-law), [E2](#e2-gdpr), [E7](#e7-contract-necessity-and-service-improvement) |
| A04 Physical machine identity | OS machine IDs, serial numbers, MAC addresses, or a cross-service hardware fingerprint. No demonstrated requirement for the proposed controls.                                                                                              | Excluded                   | [E2](#e2-gdpr), [E3](#e3-german-supervisory-guidance)                                               |

Security classification does not establish that the existing client/server
already implements an adequate defense. A random reporting ID or access token
proves neither genuine CLI execution nor truthful usage counts. Fake clients
can claim another repository hash or register fresh identities. Installation
resets are not evidence of a new physical machine.

An identifier needed for A01 cannot automatically acquire U06/U07 product
analysis purposes. Assess any additional purpose and compatibility separately,
including whether the original device access had multiple purposes. Aggregate
operational summaries may be possible after that assessment; neither all
secondary statistics nor all secondary uses are automatically allowed or
forbidden ([E2](#e2-gdpr), [E3](#e3-german-supervisory-guidance)).

## Product-specific use cases

These cases define the observation unit independently of legal classification.
Candidate dimensions remain subject to the tables above and a schema review.

| Use case                                          | Observation unit and candidate dimensions                                                                                                                                                         | Route and interpretation                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palamedes built-in command                        | One native entry-point call to `extract`, `lint`, `audit`, `report`, `catalog merge`, `catalog convert`, or `catalog compile`; tool version and daily count.                                      | U02. Current wire categories include `catalogmerge`, `catalogconvert`, and `catalogcompile`. Do not rename them through this document.                            |
| Tool/plugin invoked under Palamedes               | One explicit dispatch of a reviewed public component and operation. An attempt count is not a success count; pick one definition before implementation. Custom/private tool names remain `other`. | U03. Current integration reports the broad `plugin` category; it does not supply a component-by-component breakdown.                                              |
| Internal work performed by a command              | A command may parse many files, run checks, and invoke helpers. These are internal operations, not extra CLI invocations.                                                                         | Any proposed component observation belongs to U03/U13. Do not count each internal operation as another user command.                                              |
| Palamedes catalog command                         | One `merge`, `convert`, or `compile` invocation, independently of how many files/locales it touches.                                                                                              | U02. A command count and a catalog-load count must have different units and must not be added together.                                                           |
| Palamedes local translation catalogs              | One successfully loaded resource per process, with reviewed format and count. If measuring logical catalogs instead, deduplicate locale variants/reloads locally and document that changed unit.  | U04. Local loading/compilation creates no server download event. No private catalog identity or message content is uploaded.                                      |
| Public catalog package fetched remotely           | One actual request for a reviewed public catalog/package ID and version from an operated endpoint. Private repository-specific catalog URLs must not become analytics labels.                     | S04 for server observations; U04 if the client additionally reports local consumption. A download does not prove a catalog was used.                              |
| Runtime translation catalogs in an application    | Browser/server application loads and end-user activity are a separate population from developers invoking `pmds`.                                                                                 | Outside the initial CLI scope. No implicit instrumentation through generated catalog modules or the Palamedes runtime.                                            |
| Vite/Next.js plugins, Rust library, or Node API   | A caller may perform the same work without entering the CLI.                                                                                                                                      | Outside the initial CLI scope. A CLI grant does not automatically authorize instrumentation of every integration.                                                 |
| Syntax-download service                           | One existing request for a syntax artifact, public syntax ID/version, format, and optional platform variant. Cache hits and conditional requests have their own request semantics.                | S02/S03/S05. Normal and optimized artifacts can be distinguished as service products without inventing an extra device probe.                                     |
| Dalo version checks                               | One existing version request with tool/channel labels. Local hourly caching suppresses requests, and shared CDN caching can bypass the origin handler.                                            | S01. These are request counts, not commands, active installations, or skill/catalog usage.                                                                        |
| Repeated loads, retries, wrappers, and watch mode | Retries remain delivery attempts; npm/native wrappers have one invocation owner; a watch process can reload many catalogs during one invocation.                                                  | Keep request counts, CLI invocations, component dispatches, and resource loads separate. Record the chosen deduplication/window semantics before adding a metric. |

For a local load of a known public catalog, a separately reviewed extension
could report its stable public package ID and version, as well as its format.
This still belongs to U04 and requires opt-in: the public identity does not
turn a local load into a server request. Resolve IDs against a public allowlist;
unknown and private catalogs contribute only to the count/format categories.
Do not derive identity by hashing a private catalog name or path.

The implementation boundary is visible in the
[Palamedes dispatch and telemetry categories](https://github.com/sebastian-software/palamedes/blob/33aebc2fb023e1c7533218160a49516e3a48ff25/crates/palamedes-cli/src/cli.rs#L83)
and [local catalog compilation](https://github.com/sebastian-software/palamedes/blob/33aebc2fb023e1c7533218160a49516e3a48ff25/crates/palamedes-cli/src/commands/catalog/compile.rs#L128).
These pinned references describe the inspected source, not an assertion that a
consumer release contains every proposed metric. The current
[telemetry policy](../../contracts/telemetry-v1-policy.json) owns command
allowlists; [reporting](../reporting.md) owns implemented measures.

## No-consent candidates and accepted uncertainty

| Candidate                                    | Argument for collection without consent                                                                                                             | Contrary evidence and selected outcome                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional version requests (S01/S05)        | Route labels already select the requested service; immediate server aggregation adds no client probe or identifier.                                 | Connection processing still needs transparency and a GDPR basis where personal data is involved. Select this narrowly scoped default-on design once its operational switch is enabled; implement opt-out and document incomplete origin coverage.                                                                                                                      |
| Resource and artifact demand (S02-S04)       | The serving system already needs the public resource/variant to fulfill the request.                                                                | Observe at the actual serving system. A client-side report after a download or cache hit adds a separate acquisition path. Keep those current rich reports opt-in.                                                                                                                                                                                                     |
| Country-only request totals (S06)            | An already available request IP could be immediately reduced to a country bucket without individual history.                                        | Geolocation adds an analytics purpose and requires processor/source and balancing assessment. No country collection is implemented here; this is a viable candidate, not a categorical ban.                                                                                                                                                                            |
| Identifier-free CLI counter (U01)            | A public command category and compiled version, no persistent identity, queue, device probe, or cross-request linkage, substantially reduce impact. | EDPB paragraphs 32-39 include distributed SDK instructions, generated information, and RAM; DSK paragraphs 89-90 make purpose decisive and do not grant a simple-counter exemption. No demonstrated necessary service function supports the extra analytics request in the current design. Keep it unresolved rather than claim permission or a universal prohibition. |
| Ephemeral CI-only counter                    | Organizational execution may reduce personal-data exposure and a short-lived scope avoids developer profiles.                                       | Legal persons and rented/provided equipment remain protected (EDPB paragraphs 18-19). CI detection alone supplies neither an exception nor an operator decision. The service path needs no CI grant; rich CI observations retain their separate explicit grant.                                                                                                        |
| Broad device/project and cross-tool profiles | More detail would improve adoption and compatibility analysis.                                                                                      | New device queries, guessable repository hashes, and persistent linkage materially change the intervention. Current detailed definitions stay opt-in; a hash, missing refusal, or generic security label does not justify switching them on.                                                                                                                           |

The objective accepts defensible ambiguity without requiring a court ruling or
zero-risk certificate for each field. The selected service implementation is a
positive no-consent decision. Unimplemented candidates need their concrete
acquisition path and rationale, not an unsupported change from `opt_in` to
`opt_out` in the catalog. No nonconsenting population is inferred from the
consenting subset. Request counts cannot establish unique users or users'
individual behavior.

## Host and infrastructure responsibilities

The host product owns what an observation means and where it occurs.
app-tracking owns the reusable collection and delivery machinery. Product
definitions should be data consumed by that machinery, so adding a reviewed
Palamedes metric does not require Palamedes-specific branches in the SDK or
service. The unified client implements this boundary; consumer adoption remains
separate from its availability in the SDK.

| Owner                  | Responsibilities                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host product           | Define the observation unit, instrument the actual operation, map private/custom values to approved categories, and provide product-specific disclosure and settings. Decide which observations are useful and propose their purposes and collection requirements for review.                                  |
| Product metric catalog | Declare stable metric IDs, units, allowed dimensions/types/values, purpose and authorization requirements, identifier scope, aggregation, retention, and cardinality limits. Keep these definitions versioned and reviewed with the product integration.                                                       |
| Shared Rust SDK        | Evaluate consent, refusals, opt-out, offline and CI policy before collecting additional values; validate dimensions; aggregate locally; manage bounded queues, retries, deletion, and background delivery. Offer common status/control APIs and optional, gated helpers for repository and system information. |
| app-tracking service   | Accept only registered product definitions and authorized report shapes; enforce collection scope, size/cardinality limits, retention, and deletion. Store and report supported measures while preserving their units and coverage limits.                                                                     |

Start with counters and typed dimensions needed by the documented cases.
Categorical dimensions use explicit public values or bounded buckets;
pseudonymous installation/project identifiers require their separately declared
scope and controls. Do not provide unrestricted property bags, private names,
or arbitrary event payloads just because transport can serialize them. A new
measurement primitive needs its own contract assessment; another metric using
an existing primitive should primarily require a definition and instrumentation.

Use one canonical definition per product to produce or validate the SDK's
typed descriptors and the service's trusted registry. For the initial design,
reviewed repository files and build-time validation are sufficient; no dynamic
registration service is needed. Register a definition before deploying a client
that emits it. The receiver does not trust definitions or a
`requires_consent: false` flag supplied by an incoming request. Clients can be
modified, so SDK checks are not a server authorization boundary or proof of
authentic tool execution.

The SDK should apply common rules to declared purposes. It must not infer a
legal basis from a field name or offer an unrestricted host override around
consent. Optional product usage stays in the usage scope described above;
necessary service protection is assessed at the actual service boundary. A
product cannot route ordinary usage events through a generic "security" bypass.

One documented product/purpose scope can cover several reviewed metrics; this
does not imply a separate prompt for every counter or dimension. Conversely,
adding an incompatible purpose or materially expanding the disclosed scope
needs a fresh assessment and, where required, renewed consent. A committed
metric catalog describes behavior; it does not grant consent to repository
users.

### One recording API and a persisted choice

Expose `record` and `download` as the two operation entry points. A separate
`request_opt_in(message)` method owns the permission flow: the host provides
its reason, and the library displays the explanation plus a data summary,
asks yes/no, and persists the answer. Both saved grants and refusals are reused.
If no answer is submitted, the choice remains undecided. The library does not prompt
in CI, background workers, nonterminal input/output, or host-designated
noninteractive modes. A separate `set_opt_in(bool)` supports explicit settings
changes. Ordinary operations neither prompt nor repeat a mode argument or
maintain their own preference file.

`request_opt_in_reminder(message)` can revisit an open or deliberately deferred
choice after 14 days, using a friendly satisfaction-oriented introduction and
explicit allow/later/never choices. It preserves refusals and withdrawals and
saves only local prompt timing before display. This timing preference is not a
usage observation or consent grant. The separate permission scopes are never
silently bundled into this invitation.

The product catalog still assigns each metric to an `opt_out` or `opt_in`
collection route. The client evaluates that assignment against its saved
choice and process policy. `set_opt_in(false)` selects baseline behavior and
removes unsent opt-in observations. `set_opt_in(true)` also permits registered
opt-in observations. A separate `set_disabled(true)` stops both routes.

Opt-in routes use shared context collection; baseline definitions omit system
and project collectors. Both use aggregation and background delivery.
Offline mode suppresses network activity while permitted local
counting can continue. Declined opt-in observations are skipped before their
data closure or system collector runs. They never fall back to a baseline
counter. Baseline batches carry neither an installation ID nor its credential.

These are mechanisms. The maintained catalog chooses the route and context
for each metric once, and the receiver validates that assignment. The initial
shipped definitions use opt-in for CLI and Ferriki usage; the opt-out route is
exercised with synthetic definitions without activating an unresolved baseline.

### Shared system context

Implement supported system-information collectors once in the Rust SDK and
make them available to every host product. The built-in field catalog owns
their types, normalization, supported platforms, unknown values, and approved
collection conditions. Product catalogs reference these shared definitions
rather than maintaining separate OS/CPU detection or authorization rules.

Candidates include OS family, coarse OS version, executable architecture,
coarse CPU family/generation, and reviewed core/memory buckets or execution
context. These are the dimensions assessed in U08-U12, not permission to probe
every available system property. Keep executable architecture distinct from
host CPU family, including under emulation. Unsupported detection yields an
unknown value or omission; never fall back to raw profiler output or a
machine-wide identifier.

A product selects a shared context set once. For an eligible observation the
SDK resolves the permitted subset and attaches it automatically; callers do
not supply those fields on every event. Apply collection policy before running
collectors. Reuse permitted coarse results within a process where useful, and
stop attaching them when their authorization no longer applies. The SDK should
not spawn a profiler or perform repeated probes for every counted operation.

A field approved for collection without consent may be enabled by default for
the assessed purpose, source, and report shape. No extra prompt is needed for
that approved collection. Optional analytics still honors its documented
opt-out and the host's disabling/offline controls. Field eligibility does not
create a new upload trigger, make it necessary for every request, or authorize
linkage with unrelated identifiers. Necessary service-protection processing
retains its separately assessed controls.

In particular, attaching a locally detected OS version or CPU generation to an
existing update request remains a new client observation. A request being
necessary for updates does not automatically exempt its extra analytics fields
([E1](#e1-terminal-access-law), [E3](#e3-german-supervisory-guidance)). Under the
current assessment, U08-U12 remain opt-in; none becomes an approved default-on
baseline through this SDK design. No-opt-in candidates and unresolved cases
need their stated assessment before activation.

### Rust interface

The new [`client::Client`](../../crates/app-tracking/src/client/mod.rs) provides
the shared API alongside the compatible legacy telemetry client. A host
selects its registered product catalog at construction:

```rust
use app_tracking::client::Client;
use std::collections::BTreeMap;

let client = Client::registered(origin, state_root, "palamedes", "2.0.0")?;

// The SDK displays the reason, asks yes/no, and saves the answer once.
let permission = client.request_opt_in("Help prioritize Palamedes commands and platform support.")?;

client.record("cli.invocation", || BTreeMap::from([
    ("command".into(), "catalogcompile".into()),
]))?;

client.flush_in_background()?;
```

The host intercepts the client's reserved worker argument before normal
command parsing. The library owns settings, queue state, collection gating,
the permission dialog, and worker handoff. No reporting network wait runs in the ordinary process;
local persistence still performs filesystem I/O. Hosts handle advisory errors
without changing command output or status. The
[client guide](../unified-client.md) owns integration details and limits.

### Tracking and resource downloads

Collection route and operation type are independent. A tracking operation
records an observation and returns without waiting for network delivery. A
resource-download operation obtains bytes needed by the caller and returns a
verified artifact or a download error. Its associated observation uses the
route declared for that metric. This requires a download API as well as the
one recording API and a persisted setting, without a separate client implementation for every combination.

Shared downloads are already planned in
[issue #48](https://github.com/sebastian-software/app-tracking/issues/48), with
[Ferriki #324](https://github.com/sebastian-software/ferriki/issues/324) as a
consumer. The SDK performs the actual HTTP transfer directly from the resource
CDN; app-tracking need not proxy resource bytes. The caller continues to own
its resource cache. A call through the same client is:

```rust
// The descriptor supplies the public resource ID, URL, expected size and
// SHA-256, plus the registered download metric and its collection route.
let verified = client.download(&resource, &DownloadOptions::default())?;
cache.store(verified)?;
```

The download API uses bounded streaming, cancellation/deadline controls, and
size/digest verification before returning a verified artifact for caching. Its
request budget is appropriate for resource transfers, independent of the
existing update-check deadline. Download errors remain visible to the caller;
statistics errors do not turn a valid artifact into a failed download. The
caller waits for the resource it needs, while reporting uses background
delivery. Declined or disabled reporting still permits the resource download.

Count one download success after complete integrity verification, not on each
retry, redirect, chunk, telemetry retry, or cache read. Failed attempts can have
a separate bounded outcome metric. A later resource/language-use event may
occur with a populated cache and is a distinct measure. The same process can
therefore have one download and many uses, or no download and many uses.

Only the app-tracking reporting endpoint receives eligible reporting metadata.
Do not place reporting credentials or device/project identifiers in CDN URLs,
headers, or redirect requests. Define redirect and destination policy in the
download contract. In offline mode the host can serve a cached artifact; a
cache miss produces an explicit offline outcome without a network request.
The Rust and Node integrations in #48 should share event definitions and
counting semantics without forcing a network/tracking dependency into Ferriki's
offline-only library builds.

### Compatibility and remaining integration

The legacy [`Invocation`](../../crates/app-tracking/src/telemetry/mod.rs)
contract continues to serve existing Dalo/Palamedes consumers unchanged. New
clients use separate local state, registered counter definitions, and
`/v1/event-batches`. Existing legacy grants are not imported as new-client
choices. The wire schema remains version 1; there is no automatic new grant or
consumer activation through importing the crate.

The new receiver and additive migration keep generic counters separate from
legacy invocation counts. The private dashboard now offers a separate
metric-specific event view for versions, resource/language categories, and system
context. Node support, cross-tool profile linking, and Ferriki adoption remain
follow-up work in #48. The
[event contract](../event-batches.md) owns executable-field semantics and rollout
requirements. This implementation does not close that broader issue.

## Controls and boundaries

- Keep update delivery usable without product-reporting consent. A shared
  setup screen can offer updates with or without usage reporting; an update
  question with a telemetry footnote does not establish a separate informed
  choice. Do not preselect consent or block ordinary CLI/CI/JSON execution with
  a forced prompt ([E6](#e6-consent-design)).
- Preserve existing refusals, offline behavior, and independent update settings.
  A repository can declare a desired policy; cloning it does not by itself
  provide personal consent for every developer. Organizational CI authorization
  and developer-device consent need separate consideration. Device ownership
  alone does not settle who may consent ([E3](#e3-german-supervisory-guidance)).
- A premium download service can have terms, entitlements, and limits. Making
  optimized files conditional on additional analytics needs its own assessment
  of voluntary choice and the actual alternative. Ordinary files are not
  automatically an equivalent alternative; a paid alternative is not
  automatically valid either ([E6](#e6-consent-design),
  [E7](#e7-contract-necessity-and-service-improvement)).
- Keep raw source, catalog messages, argv, file paths, environment contents,
  credentials, custom catalog/tool names, and machine-wide identifiers outside
  the proposed payload. A hash of a private path/name does not make it an
  approved public dimension.
- Retention and withdrawal continue to follow the existing
  [retention contract](../telemetry-retention.md). This record creates no new
  30-day limit or indefinite raw-history permission. Later anonymous summaries
  require the assessment in [RFC 0004](../rfcs/0004-historical-usage-summaries.md);
  aggregation does not cure an unjustified initial collection.

## Consequences and review triggers

Service statistics can improve coverage without treating every local action
as a service request. Detailed telemetry measures consenting participation,
and each chart must retain its denominator, unknown values, collection mode,
and coverage limits. Do not label a combined stream of S01 and U02 as total
tool usage or derive unique users from request counts.

Before adopting a no-opt-in or conditional row, document the actual source,
purposes, fields, identification scope, retention, recipients, legal basis,
necessity/balancing outcome, and effective controls in its owning contract.
That focused assessment must include CDN/provider processing and the ability
to honor the proposed analytics opt-out. Disabled access logs are not evidence
that request-level analytics already exists or that infrastructure sees no IPs.

Reassess a row when it gains an identifier, a new client probe, a private or
unbounded dimension, a longer linkage period, a new recipient/purpose, or a new
consumer population. New metric dimensions need disclosure and contract
review; this does not prescribe a new protocol generation for this pre-rollout
planning change. Revisit the living record as evidence or legislation changes.

## Evidence and limits

Each matrix row links to the passages that inform its classification. The
sources establish criteria, not approval of this particular service. No claim
is based solely on another vendor's telemetry defaults.

### E1 Terminal-access law

[Section 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html),
paragraphs 1 and 2: consent for terminal storage/access, with exceptions for
message transmission and what is strictly necessary for an expressly requested
service. This addresses the access operation, including nonpersonal information.

### E2 GDPR

[Regulation (EU) 2016/679](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679):
Article 5(1)(b), (c), and (e) for purpose, minimization, and storage limits;
Articles 6(1)(f) and 6(4) for legitimate interests and further-purpose assessment;
Articles 7, 13, and 21 for consent, information, and objection; Article 89 for
statistical safeguards. Recital 49 explicitly discusses proportionate network
and information security, including denial-of-service prevention. Neither
legitimate interest nor calling a dataset statistical dispenses with the other
applicable conditions.

### E3 German supervisory guidance

[DSK, Guidance for providers of digital services, version 1.2, November 2024](https://www.datenschutzkonferenz-online.de/media/oh/OH_Digitale_Dienste.pdf):
paragraphs 13-15 distinguish terminal access from subsequent processing;
paragraph 35 addresses the actual device user rather than ownership;
paragraphs 74-79 assess the requested service and necessity;
paragraph 83 addresses user-oriented security mechanisms;
paragraph 86 addresses devices/identifiers with several purposes;
paragraphs 88-95 distinguish simple counts from richer analysis and require a
configuration- and purpose-specific assessment. This guidance does not grant a
general analytics or security-label exception.

### E4 Server-side measurement example

[LfDI Baden-Wuerttemberg, FAQ on cookies and tracking, section 3.1](https://www.baden-wuerttemberg.datenschutz.de/faq-zu-cookies-und-tracking-2/):
an example using automatically transmitted request information, with separate
GDPR balancing and minimization conditions. It distinguishes that situation
from actively collecting extra device values, including modifying an app's
headers. The FAQ is dated March 2022 and uses the former TTDSG name; read it
with the current statute and E3/E5, not as a blanket exemption for IP tracking.

### E5 Technical scope of device access

[EDPB Guidelines 2/2023, final version 2.0, adopted October 7, 2024](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf):
paragraphs 35-39 cover generated information, storage duration, and RAM;
paragraph 43 discusses protocol/header-based collection;
paragraphs 52-53 address locally processed information sent to a server.
Paragraphs 4 and 40 explain that the technical scope analysis does not decide
whether a specific consent exception applies. Inclusion in scope is not by
itself a ruling that consent is always required.

### E6 Consent design

[EDPB Guidelines 05/2020, version 1.1, adopted May 4, 2020](https://www.edpb.europa.eu/system/files/documents/files/file1/edpb_guidelines_202005_consent_en.pdf):
paragraphs 26-38 address conditionality and equivalent alternatives;
paragraphs 42-44 address separation by purpose;
paragraph 48 notes that incentives are not categorically excluded;
paragraphs 64-74 address informed consent and information presentation.
A visible activation gesture alone does not establish voluntary, informed,
purpose-specific consent. These criteria do not require a checkbox per field.

### E7 Contract necessity and service improvement

[EDPB Guidelines 2/2019, final version 2.0, October 8, 2019](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines-art_6-1-b-adopted_after_public_consultation_en.pdf):
paragraphs 27-30 distinguish objective contractual necessity from writing a
processing purpose into terms; paragraphs 48-49 address service improvement;
paragraph 50 discusses fraud prevention and potential alternative lawful bases.
Actual access/entitlement processing and optional improvement analytics must
not be collapsed into one contractual-necessity claim.

### E8 French audience-measurement exemption

[CNIL, audience-measurement solutions, July 4, 2025](https://www.cnil.fr/fr/cookies-solutions-pour-les-outils-de-mesure-daudience):
limited purposes for the publisher, anonymous statistical outputs, and
restrictions on data combination and cross-application tracking. This supports
examining narrow designs rather than claiming all analytics requires consent.
It does not approve cross-tool repository linkage or establish a German
exemption for a Rust CLI.

## Change history

- 2026-10-29: Accept maximum useful measurement without unnecessary consent as
  the product direction, including defensible legal uncertainty. Recheck DSK,
  LfDI BW, EDPB, and GDPR sources; separate actual design decisions from legal
  prohibitions. Select aggregate functional version statistics, document the
  arguments and limits of narrower CLI/CI candidates, preserve current rich
  grants, and constrain baseline event definitions to omit device collectors.

- 2026-10-27: Record the proposed metric matrix, separate Palamedes command,
  component, and catalog use cases, and link each assessment to primary
  evidence. Keep current opt-in contracts and deployment behavior unchanged.
- 2026-10-27: Propose host-owned metric definitions with shared SDK controls
  and a trusted service registry. Add an illustrative Rust interface and make
  the gap from the implemented invocation-only contract explicit.
- 2026-10-27: Centralize reusable system collectors and their field definitions
  in the SDK, with automatic context attachment after policy checks. Separate
  approved default-on collection from the availability of a collector.
- 2026-10-27: Specify opt-out and opt-in recording entry points independently
  of operation type. Connect the planned shared download client in #48 to the
  same reporting controls, with verified-transfer and cached-use semantics.
- 2026-10-27: Replace the separate recording methods with one `record` API and
  a library-owned persisted opt-in choice. Connect the Rust client, shared
  system context, resource downloads, and separate generic counter ingestion;
  keep broader consumer and reporting work explicit.

- 2026-10-27: Keep the permission explanation, yes/no interaction, and saved
  decision in the shared Rust client; products supply the reason and choose
  a suitable request boundary. Preserve an undecided state on EOF/unavailability.
