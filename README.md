# app-tracking

Shared update checks and opt-in usage tracking for developer tools.

I want one reusable service and client contract for tools such as Dalo and
Palamedes: useful update notices, measurable usage among consenting
installations, and a repository count shared across developers and clones.

## Status

This repository contains the initial design. It does not yet contain a working
service, client library, or deployment. Accepted ADRs record the agreed
direction; proposed RFCs describe details that still need implementation and
validation.

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

All repository documentation uses US English. The design deliberately omits
credentials, private infrastructure details, and real telemetry. Examples use
synthetic identifiers and reserved example domains. Public source makes the
design inspectable; it does not establish how a future deployment is configured.

## Related projects

- [Dalo issue 1001](https://github.com/sebastian-software/dalo/issues/1001):
  originating requirements for shared update checks and telemetry.
- [version-service](https://github.com/sebastian-software/version-service):
  existing update-check service and operational experience.
- [oss-metrics](https://github.com/sebastian-software/oss-metrics): public OSS
  metrics and dashboard integration. It can later consume approved aggregates
  from this service.

License selection remains open before reusable implementation code is
published. This documentation bootstrap does not adopt either reference
repository's license by implication.
