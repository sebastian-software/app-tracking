# Optional cross-tool profile linking

Profile linking is a separately permitted feature, disabled by default. A
profile is random private local state, **not a verified person or physical
machine**. Ordinary installation IDs and credentials remain scoped to their
tool. Ordinary usage grants, shared repository hashes, and the 24-month history
choice never imply permission to link tools.

## Local choice and state

The Rust client accepts `with_shared_profile_v2(private_user_root)` and the
Node client accepts `sharedProfileRoot` without I/O. Rust also retains the
legacy `with_shared_profile` controls for v1 state. Participating tools use the same root and exact configured service-origin
string (without a trailing slash), outside
project checkouts. The host selects its appropriate private user-profile path;
there is no hardware, OS machine ID, username, or repository fallback.

`request_profile_linking(reason)` owns the additional explanation and yes/no
dialog. Saved refusals are reused. `set_profile_linking(bool)` records an
explicit settings choice. Ordinary usage permission is required before a grant;
CI is always excluded, including separately permitted isolated CI reporting.
Nonterminals, JSON/agent modes and background workers never open a dialog.
Neither construction nor ordinary recording reads or creates shared state.

`profile_status()` reports the saved tool decision and pending state.
`profile_reset_pending()` explicitly inspects shared-reset status, including
after this tool has opted out.
`sync_profile_linking()` is an explicit settings-network operation with a
five-second total budget. Register the ordinary reporting identity first.
Until an exact acknowledgement, the choice remains pending; an offline change
never claims that server data has already been removed. Eligibility begins
on the UTC date after server acknowledgement, never at a backdated client
timestamp. Renewed grants start a new future boundary. A confirmed status means
the last acknowledgement, not a continuous server-side authority check.

The client stores separate tool choices and one shared file:
`<root>/profiles-v2/<SHA256(service-origin)>/profile.json`. The v2 file format is:

```json
{
  "schema_version": 2,
  "origin": "https://example.test",
  "profile_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "token": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reset_pending": false,
  "link_attempted": false
}
```

These are synthetic values, never production defaults. ID and token are
independently generated 32-byte random values, encoded as lowercase hex.
On Unix, directory/file modes are private; Windows hosts must supply a private
user-profile ACL (the SDK does not audit all Windows ACLs). Creation is locked,
writes replace atomically, and malformed or symlinked state fails closed.
A busy creator returns a retryable local error rather than creating another
profile. Unchanged state survives tool upgrades. Lost state requires a new
explicit linking choice; it is never reconstructed from hardware. Copied state
represents the same profile, so profile counts cannot identify physical devices.

The interoperable format is stored in `profiles-v2`, using the JSON shape shown above and a distinct shared lock directory named `profile.lock`. Neither
client copies a v1 profile, reset credential, or choice into v2. Each tool must
make a new explicit choice. Legacy Rust clients and controls continue to use
`profiles-v1`; a v2 reset does not reset v1. Existing v1 server links remain
until they are explicitly withdrawn/reset or the same reporting identity is
linked elsewhere. Hosts upgrading from v1 should keep legacy controls accessible.

The v2 lock is an atomic directory created by either runtime. It never expires
or gets stolen: a paused process must not resume after another writer takes its
lock. If a crash leaves it behind, stop every participating tool first, then
remove the empty `profile.lock` directory. Do not remove it while a participant
may still be running. Network filesystems are unsupported. On Windows use a
private ACL for the root. A profile with no attempted link request can be reset locally, including offline.
Before sending a link request, each runtime persists `link_attempted` under the
shared lock. A reset that receives 404 after an attempt remains pending because a
previously timed-out first registration could still arrive after that response.
Only the exact deleted receipt rotates v2 state. An ambiguously attempted profile may therefore require service-side recovery
rather than automatic rotation.

Node exposes `requestProfileLinking`, `setProfileLinking`, `profileStatus`,
`syncProfileLinking`, `profileResetPending`, `requestProfileReset`, and
`syncProfileReset`. Rust exposes corresponding methods suffixed `_v2` while the
unsuffixed methods continue to operate on v1.

New profile choices carry their disclosure revision. Unknown scope stops
linking and requires a new affirmative choice. Feature-unused SDK state omits
the field; downgrading after use fails closed rather than discarding authority.

## Unlinking and reset

- **Unlink this tool:** save `set_profile_linking(false)` and explicitly
  synchronize it. Other tools' links and all ordinary reporting grants remain.
  Turning ordinary reporting off also queues this unlink; synchronize through
  settings or complete ordinary authenticated deletion.
- **Reset the shared profile:** `request_profile_reset()` saves a pending reset;
  `sync_profile_reset()` uses the separate shared-profile credential. For v2, an exact deleted acknowledgement rotates the local ID/token after a
  link was attempted. A never-attempted profile can rotate locally; ambiguous
  not-found responses stay pending. Legacy v1 retains its existing reset behavior. Existing
  tool choices then require new consent; they never silently relink.
- **Delete ordinary reports:** the existing tool-scoped deletion operation
  removes that tool's contributions and its link. Another tool's independent
  data remains. A shared-profile reset does not erase ordinary reports.

Tool and shared-profile credentials have different purposes. Possession of a
tool reporting token cannot reset a shared profile or delete another tool's
installation. A shared-profile token cannot authorize ordinary usage deletion.
Both go only to their specific HTTPS settings endpoints, never artifact URLs,
redirects, public output, or ordinary event batches.

## Server and reporting

`PUT /v1/profile-links/events/<installation-id>` requires that tool's active
local reporting credential and `App-Tracking-Tool`. The strict body contains
`schema_version:1`, `revision:"profile-linking-v1"`, `enabled`, `changed_at`, and
`profile_id`/`profile_token` (both null for withdrawal). The server stores a
domain-separated profile-token hash and a monotonic tool choice. Stale grants
cannot overwrite a withdrawal. At most 32 installations can link one profile,
bounding reset work. It does not merge their reporting authority or identities.

`DELETE /v1/shared-profiles/<profile-id>` authenticates only the shared credential.
A reset revokes all links in one transaction and keeps minimal reset metadata
for 90 days without renewing that deadline on retry. Active profile metadata
survives while linked active installations remain. Unlinked/inactive metadata
expires after 90 days; scheduled physical cleanup follows within 24 hours.
Installation expiry/deletion removes link metadata through the same lifecycle.
Provider backup limits and the documented recovery boundary still apply.

WorkOS protects `GET /v1/admin/profiles?from=<UTC-date>&until=<exclusive-date>`.
The window is at most 90 retained dates, local context only. The fixed read
counts profiles, tool installations, and repository projects separately. Its
at-most-seven rows describe the mutually exclusive tool combinations observed
anywhere in that complete period. Each profile appears once, even when tools
report on different days. Never sum daily uniques or call these people counts.
The read excludes unlinked, reset, expired or ineligible contributions and
exports no identifiers. Profiles never enter the public usage projection.

## Enablement

Keep `APP_TRACKING_PROFILES_ENABLED=0` until the released notice and consumer
settings explain this additional scope and withdrawal/reset controls, and the
concrete assessment is recorded in `APP_TRACKING_PROFILES_REVIEW_REFERENCE`.
Runtime and storage switches both reject new grants while keeping withdrawal
and reset accessible. Disabling reporting also disables these optional gates
through deployment configuration. A nonempty reference is documentation, not
automatic legal clearance. Existing
grants are never enrolled by deployment. The clients and server support the contract while consumer integrations remain separate work.

After provider recovery, disable the profile policy before reopening reporting,
reconcile the recovery-point gap and known revocations, and require fresh
explicit linking where necessary. The existing recovery boundary does not
promise an independent deletion journal or imply that a reset edits backups.

Hosts can show the exported `PROFILE_NOTICE` without opening a dialog or changing
state. The [additional-consent rollout](additional-consent-rollout.md) records
the disclosure boundaries and release checks.
