# Repository instructions

Use US English for repository content, including code comments, documentation,
commit messages, issues, and pull requests.

## Rust and Node.js client parity

The Rust crate and Node.js package are two implementations of the same client
contracts. Shared versions alone do not establish feature parity.

- Before changing a client feature, bug fix, default, or service contract, inspect
  both `crates/app-tracking/src` and `packages/node-client/src`. Treat behavior as
  shared unless an explicit product or runtime constraint says otherwise.
- Implement shared client behavior in both clients in the same PR. This includes
  consent and reminders, policy gates, status/settings, identity lifecycle,
  validation, wire data, retries, deletion, and download verification. API names
  and runtime mechanisms may differ; observable behavior must agree.
- A server change that adds a client capability or changes a contract must also
  assess both clients. Do not silently implement only the client used by the
  first consumer.
- Exercise equivalent scenarios in both implementations. Prefer shared fixtures
  in `contracts/` and compare each client's observable results with them when
  they cover a language-independent contract. Keep runtime-specific tests local.
- If a justified exception or staged delivery leaves a gap, record its reason,
  affected behavior, acceptance criteria, and linked tracking issue in
  [the parity notes](docs/client-parity.md). Mention it explicitly in the PR;
  matching version numbers or documentation alone do not close the gap.
- Review existing parity gaps when touching related code. Report Rust and Node
  implementation and validation status separately in the PR description.

Keep both clients on one product version, release PR, tag, and changelog using
the existing `standards` release pattern. See [the release guide](docs/releasing.md).
