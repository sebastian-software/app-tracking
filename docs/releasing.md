# Releasing the Rust client

Release Please manages the shared `app-tracking` crate. The Bunny service still
deploys main-branch commits through its existing deployment workflow. The
private root Node package is development/build tooling; it is not published.

## Normal flow

1. Use Conventional Commit PR titles and squash commits: `fix:` produces a
   patch, `feat:` a minor, and breaking changes follow the configured pre-1.0
   policy. Documentation and CI changes alone do not require a crate release.
2. After a push to `main`, `.github/workflows/publish.yml` runs Release Please.
   Its release PR updates the workspace member's `Cargo.toml`, root `Cargo.lock`,
   root `CHANGELOG.md`, and `.release-please-manifest.json` together. Review the
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

The published 0.3.0 commit is in PR #36. Merge that PR with a merge commit to
preserve the tagged commit in `main`'s ancestry, then merge this automation PR.
This one-time exception avoids treating already released background-client
changes as new changes. Future feature and release PRs can use the normal
squash-merge flow.
