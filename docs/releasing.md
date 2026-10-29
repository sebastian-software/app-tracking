# Releasing app-tracking

Rust and Node.js are artifacts of one product. They share one version, one
Release Please PR, one `app-tracking-v<VERSION>` tag, one root `CHANGELOG.md`,
and one GitHub release. The Bunny service continues to deploy main-branch
commits through its deployment workflow. The private root Node package contains
build tooling and follows the product version without being published.

The configuration follows the `rust-node-product-release-config.json` reference
in [standards](https://github.com/sebastian-software/standards/tree/main/reference/release-please).
The native Rust strategy owns the real root Cargo package and `Cargo.lock`.
Rust source stays in `crates/app-tracking` through explicit library and example
paths. Typed JSON extra-file updaters synchronize `package.json` and
`{apps,packages}/*/package.json`. There is no separate Node release component or
`cargo-workspace` plugin.

Release Please owns `CHANGELOG.md`. Its generated Markdown is narrowly excluded
from Oxfmt in `.prettierignore`, since Release Please regenerates that output on
PR updates. All authored Markdown remains subject to formatting checks.

## Normal flow

1. Use Conventional Commit PR titles and squash commits. `fix:` produces a
   patch, `feat:` a minor, and breaking changes follow the configured pre-1.0
   policy. Changes anywhere in the repository contribute to the product release.
   Documentation and CI changes alone do not require a release.
2. After a push to `main`, `.github/workflows/publish.yml` runs Release Please.
   Its release PR updates root `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`, both
   Node manifests, and `.release-please-manifest.json` together. Review the
   shared version, notes, and CI before merging.
3. Merging the PR creates the tag and GitHub release. Both registry jobs consume
   the same release signal and check out that exact tag. The Rust job verifies
   the crate at the workspace MSRV and publishes with crates.io OIDC. The Node
   job builds ESM, CommonJS, declarations, and the worker, tests the packed client,
   then publishes a single JavaScript archive with npm Trusted Publishing and
   provenance. No platform packages or native binaries are published.
4. Each job verifies its published archive against the registry checksum.

GitHub release creation, crates.io publication, and npm publication are separate
operations. A failed publish leaves a failed workflow and a GitHub release;
recover it with the same tag rather than another version bump. Tags and
published package versions are never overwritten.

## One-time configuration

- Make the organization Actions secret `RELEASE_PLEASE_TOKEN` available to this
  repository. The dedicated token lets release PRs trigger normal PR CI and needs
  repository contents, issues, and pull-request write permissions.
- In crates.io, open **app-tracking → Settings → Trusted Publishing**. Configure
  owner `sebastian-software`, repository `app-tracking`, workflow `publish.yml`,
  without an environment restriction.
- npm requires an existing package before a Trusted Publisher can be configured.
  Publish the one-time `@sebastian-software/app-tracking@0.5.0-bootstrap.0`
  placeholder manually with `--access public --tag bootstrap`. It contains no
  client implementation and is separate from the functional product releases.
  The first functional npm release shares the next Rust version, `0.6.0`.
- In npm, open **@sebastian-software/app-tracking → Settings → Trusted Publisher**.
  Select GitHub Actions, organization `sebastian-software`, repository
  `app-tracking`, workflow filename `publish.yml`, and no environment. Enable
  **Allow npm publish**, since this workflow publishes directly. Configure it
  shortly before the first automated release: a new publisher must successfully
  publish within two days. See the [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Both publication jobs use `id-token: write`; neither needs a long-lived registry
token. The Node job pins a Trusted Publishing-compatible npm CLI. A passing PR
check does not verify registry-side publisher configuration.

## Recover a failed publication

Run **Release** on `main` with `recover_tag` set to an existing public stable tag,
for example `app-tracking-v0.6.0`. Recovery validates that the GitHub release is
published and stable. Publication checks require the tag and package versions to
match. Automation is checked out separately from the tagged source so a workflow
fix can recover an older release. Tags that predate the public Node package skip
npm publication and can still recover their crate.

If a registry already contains the same usable version and exact archive
checksum, its job skips publication and succeeds. A checksum mismatch,
yanked/deprecated version, network error, or unexpected response fails visibly.
Only an explicit registry `404` permits publication.

After recovery, verify the workflow, GitHub release, both registry versions, and
checksums. A consumer rollout remains a separate step.

## Release history and migration

The existing Rust releases through `app-tracking-v0.5.0` remain unchanged. The
single root manifest starts at `0.5.0`, matching the Cargo package and both Node
manifests. The bootstrap boundary is the existing `0.5.0` release commit,
`4038485ffbd4686c3dc3e11100798aeb393c669a`. The Node feature merged afterward
therefore contributes to the next product release. Moving the existing changelog
to the root preserves its history and links to earlier tags.

The release-plan check runs the action's actual pinned Release Please
implementation. It verifies that Rust, Node, and service feature commits each
produce one release PR, update all versions, respect the previous release
boundary, include future Node packages matched by the glob, and produce a shared
patch after the first automated product release.
