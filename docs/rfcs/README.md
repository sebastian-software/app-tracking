# Requests for Comments

These RFCs describe the initial app-tracking design. They are Proposed and can
change as contracts are tested. They do not document a deployed API.

| RFC | Proposal |
| --- | --- |
| [0001](0001-service-api-and-data-model.md) | Service, API, and data model |
| [0002](0002-client-consent-and-measurement.md) | Client, consent, and measurement |
| [0003](0003-deployment-and-migration.md) | Deployment, migration, and validation |

[Accepted ADRs](../adr/README.md) constrain these proposals. Exact route names,
limits, identity scope, retention periods, runtime versions, and deployment
settings belong to the RFCs until their contracts are finalized. Implementation
work should preserve the distinction between agreed direction, proposed
defaults, and observed evidence.

Use sequential, zero-padded filenames. Once a proposal is implemented, move
executable contract details to maintained API documentation and configuration,
and link that owner from the RFC rather than maintaining competing versions.
