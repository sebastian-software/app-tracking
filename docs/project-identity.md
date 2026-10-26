# Project identity: normalization v1

The shared Rust module `app_tracking::project` derives a project identity locally
after the host's effective collection policy permits it. Update checks do not
use this module. There is no repository discovery request, filesystem access,
Git subprocess, environment lookup, logging, storage, or telemetry upload in
the component. The host supplies context; the component selects, validates,
normalizes, and hashes it.

The 0.2 crate includes this API and the [opt-in telemetry lifecycle](rust-telemetry-client.md).
The 0.1 update-only API remains independent; consumer adoption is a separate step.

## Host boundary and source selection

Call `project::identify(collection_allowed, context)` with a lazy closure that
returns owned `RepositoryContext`. Resolve explicit consent, CI eligibility,
withdrawal, and invocation suppression before passing `true`. Pass collection
permission, not upload permission: consenting offline invocations may still
collect locally under the [consent policy](telemetry-consent.md).
When false, the closure is not invoked: it must contain metadata discovery,
not merely return metadata collected earlier. Nothing runs on import.

The host selects the command's project directory and supplies:

- `Origin::Present(String)` for exactly one configured Git `remote.origin.url`.
  Read the configured URL without applying `url.*.insteadOf`, SSH configuration,
  network redirects, or provider lookups. Git resolves normal checkouts, linked
  worktrees, and nested package directories; do not assume `.git` is a directory.
- `Origin::Absent` only when origin is confirmed absent, including non-Git
  projects. Only this state permits `package_json` fallback.
- `Origin::Unavailable` for lookup failures, ambiguous/multiple origins, or
  context the host cannot safely resolve. This state returns unknown.

Read the command's relevant package.json only when needed, inside the closure.
Do not traverse arbitrary dependency packages. For global commands the host can
supply absent origin and no package. A present empty, malformed, unsupported,
or local origin blocks fallback; it must not become the package author's upstream.

For package metadata, accept a `repository` string, or an object with a string
`url` and an optional `type` equal to `git`. Ignore `directory` so all packages
in a monorepo share one project. Package-only shorthands are `owner/repository`,
`github:owner/repository`, `gitlab:namespace/repository` (including subgroups),
and `bitbucket:owner/repository`. Gist shorthand is unsupported. These are a
deliberate subset of [npm repository forms](https://docs.npmjs.com/cli/configuring-npm/package-json/#repository).

`Some(ProjectIdentity)` exposes only `hash()` and `normalization_version()`;
`None` explicitly means no known project. Omit both wire project fields for
unknown context and retain its invocation counts. There is no directory-name
fallback. Input contexts have redacted `Debug` implementations; output does not
retain the original URL or canonical string. Host adapters must also avoid
logging raw metadata, Git output, paths, or parser errors.

## Exact canonical bytes

Hash the canonical string's UTF-8 bytes with SHA-256. Encode the digest as 64
lowercase hexadecimal characters. There is no newline, tool prefix, machine
identifier, or installation salt. Send `project_id_version: 1` separately.

The parser accepts ASCII clone strings up to 8,192 bytes and package.json text
up to 1,048,576 bytes. Oversized or malformed input returns unknown. It never
trims whitespace or applies a browser URL parser's path repair.

1. Accept `https://`, `ssh://`, `git+https://`, `git+ssh://`, and SCP-style
   `[user@]host:path`. URL scheme and host comparison are ASCII case insensitive.
   SCP paths must be relative clone paths, not absolute filesystem paths.
2. Remove user information (username/password) from the authority before
   constructing canonical bytes. Reject empty or multiple `@` delimiters.
   Credential escapes stay discarded; no credential is hashed.
3. Require ASCII DNS host labels, each 1–63 characters with alphanumeric/hyphen
   syntax and no leading/trailing hyphen, total at most 253 characters. Require
   a dotted host without a trailing dot and at least one letter in the final label. IP literals and single-label SSH aliases
   are unsupported. Ports must be decimal integers 1–65535; leading zeros are
   parsed numerically.
4. Reject whitespace, controls, backslashes, query strings, and fragments. Do
   not guess whether a fragment is a branch/ref or a URL is a project web page.
   Percent-encoded hosts or paths, non-ASCII paths, and encoded separators are
   unsupported, including otherwise harmless unreserved escapes. There is no
   percent decoding or Unicode normalization in v1.
5. Path segments may contain ASCII letters, digits, `.`, `_`, and `-`. Reject
   empty segments and exact `.` or `..` segments. Provider-specific depth and
   trailing-separator rules follow below.

### Hosted providers

For `github.com`, `gitlab.com`, and `bitbucket.org`, supported HTTPS, URL-style
SSH, and SCP-style SSH use canonical `host/path` without a scheme. Accept only
the transport's default port (443 for HTTPS, 22 for SSH), or no explicit port.

The sole extra alias is SSH `ssh.github.com:443`, mapped to `github.com` as
documented by [GitHub](https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port).
Other alias/port combinations are unsupported, including `www` aliases,
enterprise host aliases, and aliases from SSH configuration.

Remove one trailing `/`, then one exact lowercase `.git` clone suffix. Reject
any remaining empty segment. GitHub and Bitbucket require exactly owner/repo;
GitLab permits nested namespaces with at least two segments. GitHub path casing
is folded to lowercase. GitLab and Bitbucket path casing is preserved
conservatively; differently cased spellings may count separately. Do not apply
GitHub rules to enterprise/custom domains.

Example canonical bytes: `github.com/example-org/example-project`.

### Other hosts

Accept only HTTPS, including the `git+https` wrapper. Canonical bytes are
`https://lowercase-host[:port]/original-path`. Omit explicit port 443; retain
other ports numerically. Preserve path casing, an exact `.git` suffix, and a
single trailing slash, because a generic server may distinguish those resources.
At least one nonempty path segment is required. Reject repeated separators.

Generic SSH is unsupported: relative paths can depend on the SSH user, so
discarding that user could merge unrelated repositories. Generic HTTPS/SSH
equivalence needs a later explicit provider contract. No DNS, SSH configuration,
or network request resolves ambiguous aliases.

## Conformance and limits

[Published JSON fixtures](../crates/app-tracking/fixtures/project-identity-v1.json)
contain synthetic inputs, exact canonical bytes, version, and golden hashes.
Rust executes every normalization and source-selection case. A separate Node
test recalculates hashes from those canonical bytes with Node's SHA-256
implementation. A real temporary Git fixture verifies one identity across a
primary checkout, clone, linked worktree, and nested monorepo directory. All
fixtures run in the Linux/macOS/Windows Rust workflow and ship in the crate.

The API has no tool or installation parameter: equivalent inputs yield the
same project across tools and developers; different fork origins remain
distinct. Unsupported context contributes to unknown-project usage. These are
conservative identity rules, not a proof that every syntactically accepted URL
exists or that all aliases of a repository can be deduplicated.

Renames, transfers, moves, changed origins, and generic transport/path differences
can change identity. No history lookup merges them. A future normalization
version cannot silently unify old and new hashes; it needs an explicit continuity
plan and new conformance fixtures. Known URLs can be guessed and hashed, so
these identifiers are pseudonymous, not guaranteed anonymous.
