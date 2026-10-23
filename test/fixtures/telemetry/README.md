# Telemetry v1 conformance vectors

All values are synthetic. No file contains a live credential, repository URL,
installation, report, or private infrastructure identifier.

- `valid.json`: registration, known/unknown-project batch, success/error
  responses, exact canonical UTF-8, and SHA-256. The golden serialization/hash
  was produced independently with Python's sorted, compact ASCII JSON and
  SHA-256; the TypeScript oracle must reproduce it without rewriting the fixture.
- `shape-cases.json`: changes to those base documents and expected JSON Schema
  validity, including consent/hash revisions, actual calendar dates, dimensions,
  count bounds, and paired project fields.
- `submission-cases.json`: authoritative server time, authority/receipt state,
  batch changes, and expected decision. Covers dropped acknowledgements, changed
  payloads, receipt expiry, midnight/skew edges, revocation and missing authority.
- `registration-cases.json`: first creation, immutable replay, credential and
  declaration conflicts, tombstone expiry, and UUID creation-time boundaries.
- `consent-cases.json`: effective consent, environment/CI/offline precedence,
  withdrawal, pending deletion, and reset that cannot silently make a new identity.

`node --test test/telemetry-contract.test.ts` checks schema validity, canonical
hashing, and a **reference decision model** against the vectors. It also checks
row/count/byte examples and retry limits. `pnpm check` includes the test.

This is not the ingestion server, Rust telemetry client, a strict raw-JSON
parser, or a database test. It does not prove streamed byte enforcement, token
verification, file permissions, transactions, simultaneous requests, durable
claims, deletion, provider recovery, or legal compliance. Implementations in
issues #6–#12 must consume these vectors and add real-boundary evidence for those
claims. Inactivity flags and existing-credential/receipt states in the model
are given preconditions, not claims that a database/authenticator has produced
them correctly. Raw duplicate JSON keys must be rejected by the future HTTP
parser, not hidden by first parsing them with a permissive JSON parser.

The maintained [API](../../../docs/telemetry-api.md),
[consent](../../../docs/telemetry-consent.md), and
[retention](../../../docs/telemetry-retention.md) describe the contract. Shape
rules live in [JSON Schema](../../../contracts/telemetry-v1.schema.json), with
numeric values/catalog in [policy JSON](../../../contracts/telemetry-v1-policy.json).
