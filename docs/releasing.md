# Releasing the Rust client

Release Please manages the shared `app-tracking` crate. The Bunny service still
deploys main-branch commits through its existing deployment workflow. The
private root Node package is development/build tooling; it is not published.

Release Please owns `crates/app-tracking/CHANGELOG.md`. Its generated Markdown
is narrowly excluded from Oxfmt in `.prettierignore`, since Release Please does
not run the repository formatter and regenerates that output on PR updates.
All authored Markdown remains subject to the normal formatting check.

## Normal flow

1. Use Conventional Commit PR titles and squash commits: `fix:` produces a
   patch, `feat:` a minor, and breaking changes follow the configured pre-1.0
   policy. Documentation and CI changes alone do not require a crate release.
2. After a push to `main`, `.github/workflows/publish.yml` runs Release Please.
   The Rust strategy targets `crates/app-tracking`, with the `cargo-workspace`
   plugin updating the root lockfile. Its release PR updates the member's
   `Cargo.toml` and `CHANGELOG.md`, root `Cargo.lock`, and
   `.release-please-manifest.json` together. Review the
   version, notes, and CI before merging the release PR.
3. Merging that PR creates `app-tracking-v<VERSION>` and a public GitHub release.
   The same workflow checks out the tag, packages and verifies the crate using
   the workspace MSRV, obtains a short-lived crates.io OIDC credential, and
   publishes the package. It verifies the registry checksum afterward.

GitHub release creation and crates.io publication are separate API operations,
not an atomic transaction. A publish failure leaves a visible failed workflow
and a GitHub release; recover it using the existing tag, without another version
bump. Neither tags nor published crates are overwritten.

## One-time configuration

- Make the existing organization Actions secret `RELEASE_PLEASE_TOKEN`
  available to this repository. Like the other tool repositories, this workflow
  uses a dedicated token so release PRs trigger normal PR CI. It needs repository
  contents, issues, and pull-request write permissions. The default
  `GITHUB_TOKEN` cannot trigger those follow-up workflows.
- In crates.io, open **app-tracking → Settings → Trusted Publishing** and add
  GitHub owner `sebastian-software`, repository `app-tracking`, workflow
  `publish.yml`, with no environment restriction. The job has `id-token: write`
  only for publication. This workflow does not use a long-lived crates.io token.
  Trusted Publishing must be configured before the first automated crate
  publication. Do not treat a passing PR check as proof of registry setup.

## Recover a failed publication

Run the **Release** workflow on `main` with `recover_tag` set to the existing
public stable release tag, such as `app-tracking-v0.3.0`. Recovery requires a
published, non-prerelease GitHub release and an exact tag/crate version match.
Automation is checked out separately from the release source, so recovery also
works for tags created before this workflow existed.

If crates.io already contains the same unyanked version and archive checksum,
the workflow skips authentication/publication and succeeds. A checksum mismatch,
yanked version, network error, or unexpected registry response fails visibly.
Only an explicit registry `404` permits a new publish attempt. Authentication
does not authorize replacing an existing package.

After recovery, verify the workflow, GitHub release, crates.io version, and
package checksum. A consumer rollout remains a separate step.

## Migrating the manual releases

Versions through 0.3.0 were published manually. The 0.3.0 GitHub release was
backfilled at the existing tag; its crate and source remain unchanged. The
manifest starts at 0.3.0 so automation does not try to publish that version again.

The manual 0.3.0 tag points to `cce58849e115c29486c10795c415b2fe13a1823f`.
PR #36 was integrated with rewritten commit IDs. Its main-branch equivalent,
`2255931ac5c7b90d8737aec062ddcf538e5e45e6`, has exactly the same tree
(`73f3625c4d3055dd1556ecd932b8b9300762277b`). The configuration's
`last-release-sha` sets this equivalent commit as the historical lower bound,
so already shipped features are not collected again. The original tag and
published crate remain unchanged. Later automated release commits stop history
collection before that bound; it does not override subsequent release versions.

Normal feature and release PRs can use squash merges. The release-plan check
exercises the actual pinned Release Please implementation against the virtual
workspace, including the manual baseline and a later automated release.
