# app-tracking

Useful update notices. Optional usage reporting. Clear choices.

app-tracking gives developer tools a shared service and Rust client for update
checks and opt-in usage reporting. It helps maintainers understand which
versions and command categories are used, so they can make informed decisions
about their tools. You can keep update checks enabled without sharing usage.

**Using a tool that links here?** Start with
[what is shared, why, and how you stay in control](https://sebastian-software.github.io/app-tracking/).
The page explains the design in plain language; the contracts below provide the
details.

## Your choice comes first

The current v1 design keeps update checks and usage reporting independent:

- **Reporting starts with your opt-in.** Before consent, the client creates no
  reporting identity, project hash, usage counters, or queue. CI reporting
  requires a separate explicit opt-in.
- **Updates work without reporting.** The update client checks public release
  metadata without a reporting identity or project information. It never
  installs or executes an update.
- **You can inspect and change your choice.** Integrating tools must expose
  status, an unsent-payload preview, disable, and deletion controls. Disabling
  stops collection and upload and discards unsent usage. Deletion is a separate
  request; an offline request stays visibly pending until resolved.
- **Reporting stays in the background.** The Rust client can record locally and
  deliver due reports in a short-lived worker, without waiting for telemetry
  networking in the command you run. Offline mode blocks networking.

Control names belong to each integrating tool. See its documentation for the
commands and settings it provides, or read the shared
[consent and controls contract](docs/telemetry-consent.md).

## What reporting can share

With consent, v1 summarizes invocations locally and normally uploads daily
while you use the tool. Reports contain the UTC day, tool and version, an
allowlisted command category, count, local/CI context, consent revision, and a
separate installation ID for the tool and profile. Registration records consent
time; installation and batch IDs also encode their creation time.

When reliable repository metadata exists, the client can include a SHA-256 hash
of the normalized repository URL. This lets maintainers count reporting
repositories across clones, developers, and tools without receiving the URL.
**The hash is guessable from a known URL, so reporting is pseudonymous, not
promised anonymous.** Installation IDs are separate across tools.

The reporting payload excludes source code, command arguments, file paths,
repository URLs, usernames, machine names, environment contents, and skill
content or names. The [wire contract](docs/telemetry-api.md) defines the exact
fields; the [project identity contract](docs/project-identity.md) explains the
repository hash.

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

Broader metric definitions and possible service statistics are being explored in
[proposed ADR 0010](docs/adr/0010-metrics-purposes-and-consent.md). That proposal
does not change v1's opt-in requirement or enable new collection. Durable
historical summaries and public usage exports remain proposed in
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
then follow the [update integration guide](docs/rust-client.md) or the
[telemetry integration guide](docs/rust-telemetry-client.md). The host owns its
user-facing controls, output policy, and consent flow.

Questions, corrections, and integration ideas are welcome in
[GitHub issues](https://github.com/sebastian-software/app-tracking/issues).
The [delivery tracker](https://github.com/sebastian-software/app-tracking/issues/17)
connects implementation work and its acceptance evidence. Repository work uses
[US English](docs/adr/0001-english-project-language.md); examples use synthetic
identifiers rather than real telemetry or private infrastructure details.

### Developer documentation

| Looking for…                       | Start here                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terms and design decisions         | [Glossary](GLOSSARY.md), [ADRs](docs/adr/README.md), [RFCs](docs/rfcs/README.md)                                                                                                                            |
| Consent, fields, and data lifetime | [Consent](docs/telemetry-consent.md), [API](docs/telemetry-api.md), [retention](docs/telemetry-retention.md), [project identity](docs/project-identity.md)                                                  |
| Service architecture and adoption  | [Service and data model](docs/rfcs/0001-service-api-and-data-model.md), [client and measurement](docs/rfcs/0002-client-consent-and-measurement.md), [migration](docs/rfcs/0003-deployment-and-migration.md) |
| Deployments and releases           | [Deployment](docs/deployment.md), [crate releases](docs/releasing.md), [operations](docs/operations.md)                                                                                                     |
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
