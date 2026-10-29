# app-tracking

Useful update notices. Service statistics. Optional detailed usage reporting.

app-tracking gives developer tools a shared service and Rust client for update
checks and opt-in usage reporting. It helps maintainers understand which
versions, command categories, and supported platforms are used, so they can
make informed decisions about their tools. You can keep update checks enabled
without sharing usage.

**Using a tool that links here?** Start with
[what is shared, why, and how you stay in control](https://app-tracking.sebastian-software.com/)
([German](https://app-tracking.sebastian-software.de/)).
The page explains the design in plain language; the contracts below provide the
details.

## Your choice comes first

Update checks and usage reporting remain independent. Every metric in the
current shipped event catalog requires opt-in:

- **Reporting starts with your opt-in.** Before consent, the client creates no
  reporting identity, project hash, usage counters, or queue. CI reporting
  requires a separate explicit opt-in.
- **Updates work without reporting.** The update client checks public release
  metadata without a reporting identity or project information. It never
  installs or executes an update.
- **You can inspect and change your choice.** Integrating tools must expose
  status, an unsent-payload preview, disable, and deletion controls. Disabling
  stops collection and upload and discards unsent usage. Deletion is a separate
  request; offline mode prevents that request from reaching the service.
- **Reporting stays in the background.** The Rust client can record locally and
  deliver due reports in a short-lived worker, without waiting for telemetry
  networking in the command you run. Offline mode blocks networking.

Control commands belong to each integrating tool. The unified Rust SDK owns
its permission dialog and saved choice; the host supplies the product-specific
reason and exposes the settings. It needs no separate opt-in preference file.
See the [unified client guide](docs/unified-client.md) for these controls and
the [legacy consent contract](docs/telemetry-consent.md) for invocation-client
behavior. The legacy client bounds pending offline deletion to 90 days after
withdrawal, then shows deletion as unverified if it was not acknowledged.

## Service demand without a permission dialog

A separate [service-statistics path](docs/service-statistics.md) can count
functional version requests by day, tool, distribution/channel, and response
category without usage consent. It stores shared counters, with no client
identifier or device query, and honors DNT/GPC. Clients can disable it with
`UpdateClient::with_service_metrics(false)` while retaining update checks.
The path has its own deployment switch and private reporting API; it measures
origin request demand, not users, installations, or local invocations.

The [measurement decision](docs/adr/0010-metrics-purposes-and-consent.md) records
the objective of maximum useful measurement without unnecessary consent,
including defensible gray areas and the limits of each candidate design.

## What detailed reporting can share

Both reporting contracts aggregate counts locally by UTC day and normally
upload daily while the tool is used. They have distinct payloads and state:

- **Legacy invocation reporting** shares tool/version, an allowlisted command
  category, count, local/CI context, consent revision, and a tool/profile-scoped
  installation ID. Registration records consent time; installation and batch
  UUIDs encode their creation time. See the [invocation contract](docs/telemetry-api.md).
- **Generic event reporting** shares tool/version, metric, finite categorical
  dimensions, UTC day, count, local/CI context, and the explicit grant time.
  Installation and batch IDs are random hexadecimal identifiers with no
  embedded timestamp. See the [event-batch contract](docs/event-batches.md).

The [current event catalog](contracts/event-catalog.json) defines CLI invocation
counts for Dalo and Palamedes, verified resource-download counts by kind for
Ferriki, and Ferriki language-use counts by language and explicit/dependency
source. All shipped definitions use `opt_in`, full system context, and optional
project context. Full system context includes OS family and normalized version,
executable architecture, and CPU family; Linux also separates distribution,
distribution version, and kernel version. Raw hardware model strings are not
sent. The SDK checks collection policy before resolving system or project
context. Catalog definitions do not establish that consumer instrumentation is
already released.

When reliable repository metadata exists, both clients can include a SHA-256
hash of the normalized repository URL. This lets maintainers count reporting
repositories across clones, developers, and tools without receiving the URL.
**The hash is guessable from a known URL, so reporting is pseudonymous, not
promised anonymous.** Installation IDs are separate across tools.

The reporting payload excludes source code, command arguments, file paths,
repository URLs, usernames, machine names, environment contents, and skill
content or names. The [invocation contract](docs/telemetry-api.md) defines legacy
fields, and the [event-batch contract](docs/event-batches.md) owns generic fields.
The [project identity contract](docs/project-identity.md) explains the repository
hash.

The retention contract limits active usage reporting to 90 days, with physical
cleanup within another 24 hours and a seven-day maximum policy for ordinary
database backups. Deleting active data does not edit backups in place. Bunny
hosts the API and PlanetScale stores reporting data; infrastructure providers
also process network and security metadata under their own terms. See the
[retention and provider disclosure](docs/telemetry-retention.md) for those
boundaries.

These documents explain the implemented contract. They do not establish a
consumer's live settings or replace its released privacy notice. Production
activation requires the actual notice, provider configuration, and evidence in
the [operations runbook](docs/operations.md).

## What is ready

The version API, shared Rust client, consent-gated ingestion, deletion,
retention, and private maintainer reporting are implemented. The service builds
as a self-contained Bunny edge script; version-only operation needs no database
or telemetry configuration. Main-branch service deployments run through GitHub
Actions after automated checks.

The Rust library does nothing on import or construction. Consumer adoption and
production telemetry activation are separate steps. Private
[maintainer reporting](docs/reporting.md) requires explicit enablement, WorkOS
authorization, and a separate database login. Its counts describe participating
installations and repositories, not people or everyone who uses a tool.

The [unified client](docs/unified-client.md) adds one `record` API, verified
resource downloads, shared system collectors, and a persisted permission flow.
Its [generic event batches](docs/event-batches.md) are stored separately from
legacy invocation counts. The private dashboard has a separate metric-specific
event view with version, language/resource, and system breakdowns. The
[Node client](packages/node-client/README.md) provides a platform-independent
TypeScript package with local installed-package tests; npm publication and
consumer rollout remain follow-up work under
[issue #48](https://github.com/sebastian-software/app-tracking/issues/48).

[ADR 0010](docs/adr/0010-metrics-purposes-and-consent.md) records the implemented
service-statistics path and assessments for broader metrics. The generic
protocol supports an opt-out route, but the current shipped catalog contains no
production baseline metrics. Neither that mechanism nor the assessment enables
default-on client reporting. Durable historical summaries and public
usage exports remain proposed in
[RFC 0004](docs/rfcs/0004-historical-usage-summaries.md).

## Try the service locally

Use the Node version in [.node-version](.node-version) and the pnpm version in
[package.json](package.json). No credentials are needed for this version-only
setup:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm dev
```

The server listens on `http://127.0.0.1:8787`. In a second terminal:

```sh
curl -i http://127.0.0.1:8787/v1/versions/dalo/github/stable
curl -i http://127.0.0.1:8787/health
```

`pnpm check` verifies formatting, types, synthetic tests, bundling, and SDK
registration in a local runtime harness. HTTP tests use ephemeral loopback
ports and do not contact public sources. The separate `pnpm smoke:upstreams`
command performs an opt-in, read-only check of the public oss-metrics snapshot.

`pnpm build` produces `dist/edge.js` for Bunny and `dist/service.js` with an
exported `createHandler` for integration; both have no external imports. The
[version API reference](docs/version-api.md) covers response and cache behavior.

## Integrate or contribute

For a Rust tool, start with the [crate README](crates/app-tracking/README.md),
then follow the [unified client guide](docs/unified-client.md). The SDK's explicit
`request_opt_in(reason)` call presents its shared explanation and saves the
answer for the tool/service/profile. The host chooses a suitable interactive
point, supplies the reason and privacy/settings link, maps process restrictions,
and exposes control commands. Construction, `record`, and `download` do not
prompt automatically; a changed metric scope needs a fresh permission request.
Legacy consent is not imported into the new client.

For a Node.js tool, use the [Node client guide](packages/node-client/README.md).
Its pure JavaScript bundles need no native addons. Node and Rust use separate
state and permission namespaces; grants and credentials are never copied.

Changes to shared client behavior must cover both implementations. Follow the
[client parity rules and known gaps](docs/client-parity.md) when contributing.

The [update integration guide](docs/rust-client.md) and
[legacy telemetry guide](docs/rust-telemetry-client.md) remain available for
existing APIs. Adopt generic reporting only after its service migration and
runtime grants are deployed; the [deployment runbook](docs/deployment.md)
describes service-first rollout and verification.

Questions, corrections, and integration ideas are welcome in
[GitHub issues](https://github.com/sebastian-software/app-tracking/issues).
The [delivery tracker](https://github.com/sebastian-software/app-tracking/issues/17)
connects implementation work and its acceptance evidence. Repository work uses
[US English](docs/adr/0001-english-project-language.md); examples use synthetic
identifiers rather than real telemetry or private infrastructure details.

### Developer documentation

| Looking for…                       | Start here                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified metrics and downloads      | [Unified client](docs/unified-client.md), [event batches](docs/event-batches.md), [current catalog](contracts/event-catalog.json)                                                                           |
| Terms and design decisions         | [Glossary](GLOSSARY.md), [ADRs](docs/adr/README.md), [RFCs](docs/rfcs/README.md)                                                                                                                            |
| Consent, fields, and data lifetime | [Consent](docs/telemetry-consent.md), [API](docs/telemetry-api.md), [retention](docs/telemetry-retention.md), [project identity](docs/project-identity.md)                                                  |
| Service architecture and adoption  | [Service and data model](docs/rfcs/0001-service-api-and-data-model.md), [client and measurement](docs/rfcs/0002-client-consent-and-measurement.md), [migration](docs/rfcs/0003-deployment-and-migration.md) |
| Deployments and releases           | [Deployment](docs/deployment.md), [product releases](docs/releasing.md), [operations](docs/operations.md)                                                                                                   |
| Storage and ingestion evidence     | [Storage proof](docs/storage-proof.md), [ingestion](docs/telemetry-ingestion.md), [deletion and retention lifecycle](docs/telemetry-lifecycle.md)                                                           |
| Private maintainer statistics      | [Reporting guide](docs/reporting.md)                                                                                                                                                                        |
| Public project website             | [Preview, deployment, and linking guide](docs/website.md)                                                                                                                                                   |

## Related projects

- [Dalo](https://github.com/sebastian-software/dalo/issues/1001) supplied the
  originating requirements for shared update checks and reporting.
- [version-service](https://github.com/sebastian-software/version-service)
  provides the earlier update-service experience.
- [oss-metrics](https://github.com/sebastian-software/oss-metrics) supplies public
  release snapshots for version delivery. Any future export of usage aggregates
  is a separate decision.

## License

Available under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. [ADR 0007](docs/adr/0007-dual-license.md) records the decision.
[Third-party notices](THIRD_PARTY_NOTICES.md),
[authentication notices](AUTH_NOTICES.md), and
[database driver notices](STORAGE_PROOF_NOTICES.md) cover bundled dependencies.
