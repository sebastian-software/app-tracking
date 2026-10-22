# app-tracking

Shared update checks and opt-in usage tracking for developer tools.

I want one reusable service and client contract for tools such as Dalo and
Palamedes: useful update notices, measurable usage among consenting
installations, and a repository count shared across developers and clones.

## Status

The version endpoint is implemented with a reviewed release catalog, conditional
GET, bounded registry requests, and deterministic contract tests. It builds a
self-contained Bunny edge script and runs locally without a database or
telemetry. Production deployment, shared clients, and usage tracking are later
delivery steps. Accepted ADRs record direction; RFCs retain the unimplemented
proposals.

## Run and verify

Use the Node version in [.node-version](.node-version) and the pnpm version in
[package.json](package.json). Install the pinned development dependencies:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm dev
```

The local server listens on `http://127.0.0.1:8787`. In a second terminal:

```sh
curl -i http://127.0.0.1:8787/v1/versions/dalo/npm/stable
curl -i http://127.0.0.1:8787/health
```

`pnpm check` verifies formatting, types, synthetic tests, bundling, and SDK
registration in a local runtime harness. The HTTP tests bind ephemeral loopback
ports; they do not contact public registries. `pnpm smoke:upstreams` is a
separate, opt-in read-only check against the configured public sources.

`pnpm build` produces `dist/edge.js` for Bunny and `dist/service.js` with an
exported `createHandler` for integration. Both have no external imports. No
credentials or environment configuration are needed for this slice. See the
[version API contract](docs/version-api.md) for supported paths, errors, cache
behavior, and the remaining deployment proof.

## Implementation plan

The [delivery tracker](https://github.com/sebastian-software/app-tracking/issues/17)
contains the implementation issues, suggested order, and completion
dependencies. Start with the
[version endpoint](https://github.com/sebastian-software/app-tracking/issues/1),
then ship Bunny version delivery and the shared update client before enabling
telemetry. Each issue defines its scope and acceptance evidence; the tracker
owns delivery status.

## Direction

- Build a new service with its own API and deployment. Use `version-service`
  and `oss-metrics` as references, and migrate tools independently.
- Keep update checks useful when telemetry is declined or unavailable.
- Collect and send usage only after explicit opt-in.
- Derive a shared project identifier locally from the SHA-256 of a normalized
  repository URL. Never send the original URL.
- Host the service on Bunny and use PlanetScale for persistent usage data.
- Report invocations, reporting installations, and reporting projects as
  distinct measures. None is a count of people or all users.

The initial client design uses hourly version checks during tool use and
normally daily telemetry batches. The service owns one release-metadata path
for both standalone version responses and optional release information in
telemetry responses.

## Design documents

- [Domain glossary](GLOSSARY.md)
- [Architecture decisions](docs/adr/README.md)
- [RFCs](docs/rfcs/README.md)
- [Service, API, and data model](docs/rfcs/0001-service-api-and-data-model.md)
- [Client, consent, and measurement](docs/rfcs/0002-client-consent-and-measurement.md)
- [Deployment, migration, and validation](docs/rfcs/0003-deployment-and-migration.md)

All project work uses [US English](docs/adr/0001-english-project-language.md).
ADRs are [living documents](docs/adr/0002-living-decision-records.md) that keep
the current decision in a stable location with dated changes and Git history.
The design deliberately omits credentials, private infrastructure details, and
real telemetry. Examples use synthetic identifiers and reserved example
domains. Public source makes the design inspectable; it does not establish how
a future deployment is configured.

## Related projects

- [Dalo issue 1001](https://github.com/sebastian-software/dalo/issues/1001):
  originating requirements for shared update checks and telemetry.
- [version-service](https://github.com/sebastian-software/version-service):
  existing update-check service and operational experience.
- [oss-metrics](https://github.com/sebastian-software/oss-metrics): public OSS
  metrics and dashboard integration. It can later consume approved aggregates
  from this service.

## License

Available under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. [ADR 0007](docs/adr/0007-dual-license.md) records the decision.
[Third-party notices](THIRD_PARTY_NOTICES.md) cover the SDK bundled for Bunny.
