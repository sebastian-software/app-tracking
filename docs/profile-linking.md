# Optional cross-tool profile linking

Profile linking is a separately permitted feature, disabled by default. A
profile is random private local state, **not a verified person or physical
machine**. Ordinary installation IDs and credentials remain scoped to their
tool. Ordinary usage grants, shared repository hashes, and the 24-month history
choice never imply permission to link tools.

## Local choice and state

The unified Rust client accepts `with_shared_profile(private_user_root)` without
I/O. Participating tools use the same root and exact configured service-origin
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
`<root>/profiles-v1/<SHA256(service-origin)>/profile.json`. Its exact v1 format is:

```json
{
  "schema_version": 1,
  "origin": "https://example.test",
  "profile_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "token": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reset_pending": false
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

This is a shared file/wire contract for a future Node client too. The Node SDK
and its adoption remain deferred. Do not claim Rust/Node client interoperability
has been exercised until the Node implementation runs the same lifecycle proof.
New profile choices carry their disclosure revision. Unknown scope stops
linking and requires a new affirmative choice. Feature-unused SDK state omits
the field; downgrading after use fails closed rather than discarding authority.

## Unlinking and reset

- **Unlink this tool:** save `set_profile_linking(false)` and explicitly
  synchronize it. Other tools' links and all ordinary reporting grants remain.
  Turning ordinary reporting off also queues this unlink; synchronize through
  settings or complete ordinary authenticated deletion.
- **Reset the shared profile:** `request_profile_reset()` saves a pending reset;
  `sync_profile_reset()` uses the separate shared-profile credential. Only an
  exact deleted/not-found acknowledgement rotates local ID/token. Existing
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
grants are never enrolled by deployment. The current implementation prepares
Rust and server support while the consumer integrations remain separate work.

After provider recovery, disable the profile policy before reopening reporting,
reconcile the recovery-point gap and known revocations, and require fresh
explicit linking where necessary. The existing recovery boundary does not
promise an independent deletion journal or imply that a reset edits backups.
