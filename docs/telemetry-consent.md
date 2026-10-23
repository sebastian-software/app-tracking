# Telemetry consent and client behavior: v1

This is the client contract for future implementation, not a description of
functionality in the current `app-tracking` crate. The
[wire contract](telemetry-api.md) owns requests and exact time boundaries;
[retention](telemetry-retention.md) owns server data lifetime and launch evidence.

## Disclosure supplied before opt-in

The following is the common disclosure for `telemetry-v1`. Hosts substitute
only their public tool name and the documented local command/path for the
controls. They must expose this whole notice before accepting consent, without
preselected consent or interrupting an ordinary command with a forced choice.

> Optional usage reporting is operated by **Sebastian Software GmbH**
> ([legal notice](https://oss.sebastian-software.com/imprint), privacy contact:
> info@sebastian-software.de). It helps us understand how often the tool runs,
> which command categories and versions are used, and how many reporting
> installations and repositories participate. It does not measure people or
> everyone who uses the tool.
>
> If you enable it, the tool counts invocations locally and normally uploads
> daily while you use it. Reports contain UTC day, tool/version, command category,
> count, a separate installation ID for this tool and profile, consent revision,
> and local/CI context. Registration includes when you gave consent. Installation
> and batch IDs also contain their creation time. We do not send command
> arguments, skill content/names, source code, repository URLs, local paths,
> usernames, machine names, session IDs, or an installed-version update request.
>
> When reliable project metadata exists, we send SHA-256 of the normalized
> repository URL. Different clones/developers of the same repository share the
> hash, including across our tools; forks remain different. This lets us count
> repositories. Someone who guesses a repository URL can calculate and match its
> hash. These reports are pseudonymous, not promised anonymous. Your installation
> ID is not shared across different tools. CI reporting is separately opt-in and
> is kept distinct from local usage.
>
> Reports use HTTPS to the app-tracking service at
> https://sebastian-app-tracking.b-cdn.net. Bunny hosts the API and processes
> network metadata such as IP addresses; PlanetScale stores reporting data.
> Their infrastructure and subprocessors may involve international processing.
> The released notice must link the current processor/transfer information;
> choosing an EU database does not establish EU-only processing.
>
> Usage is retained for at most 90 days in active reporting, with physical
> cleanup within another 24 hours. Receipts last 90 days from receipt. A minimal
> revoked-identity record lasts 90 days after revocation, without usage or
> repository hashes. Ordinary database backups have a seven-day maximum policy
> and are not queried for reporting; deleting active data does not edit a backup
> in place. Provider-managed restore is described in the retention policy.
> Application logs never contain your reports or credentials. Separately
> processed provider security/transport records follow the released processor
> notice and verified operational retention bounds.
>
> Reporting is off until you opt in. Declining does not limit the tool or its
> independently configurable update checks. You can inspect the effective
> setting and queued payload without sending it, disable reporting at any time,
> or request deletion using the locally held credential. Disabling stops new
> collection/upload and discards unsent usage. Deletion stops reporting and
> removes retained active contributions after acknowledgement. Offline deletion
> remains visibly pending; you can retry when online. If the credential is lost,
> we cannot authenticate automatic deletion or identify you from an account;
> contact the privacy address for assistance. We will not ask you to disclose
> repository URLs as proof. Resetting changes the installation count and does
> not merge old and new identities.
>
> Consent is optional and can be withdrawn as easily as it is given. You can
> contact us about access, erasure, restriction, correction, objection where
> applicable, and portability, or complain to a supervisory authority. Preview
> shows the locally held data; it is not a server-side access export. The full
> released privacy notice must explain the applicable rights and legal bases.

This is product copy for review, not legal sign-off. The final released notice
must name the actual controller/contact, tool controls, privacy URL, processors,
transfer safeguards, and applicable rights before production enablement. Those
public business details are not private deployment identifiers. The existing
website privacy page is not automatically a notice for this new service.

## Consent states and controls

The host supplies semantic operations equivalent to the following table. Their
CLI spelling belongs to the consumer issue; none exists in the current client.
A future host should group them under a discoverable `telemetry` command.

| State/action          | Required local behavior                                                                                                     | Network behavior                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Undecided or declined | No telemetry ID, project hash, counters, queue, or request                                                                  | Version policy remains independent                           |
| Enable revision v1    | Show disclosure; record affirmative revision, consent time, and decision source                                             | Register only when online and eligible                       |
| Status/inspect        | Show effective policy, source, revision, context, pending deletion, queue totals/expiry, and locally held IDs; redact token | None                                                         |
| Preview               | Render exact unsent payloads, including project hashes, and expiry/conflict state; never raw URL or token                   | None                                                         |
| Disable/withdraw      | Persist withdrawal; stop collection/upload and delete unsent counters, batches, and conflict payloads atomically            | No implicit deletion request                                 |
| Delete                | Withdraw first; retain only ID/token and deletion status until resolved                                                     | Explicit authenticated DELETE, or visibly pending if offline |
| Reset                 | Explicit new identity boundary, never a retry strategy                                                                      | Complete old deletion first; offline reset remains pending   |
| Renew consent         | New disclosure and affirmative grant; no reinterpretation of an older revision                                              | Delete old authority before registering a new identity       |

Only `telemetry-v1` is accepted. Unknown/retired revisions stop collection and
upload and require a new grant. Deletion remains available under old credentials.
No new consent is inferred from a software update, import, update check, receipt,
TTY presence, old automatic reporting, or an old opt-out setting.

Inactivity is 90 days without a qualifying local invocation; the server also
expires authority after 90 days without a newly accepted batch. When either
boundary is reached, stop reporting and require a new affirmative grant; do not
silently rotate monthly or reactivate an expired installation. Uninstall/lost
state can prevent deletion; server expiry and data retention still apply.

If a registration's outcome is unknown, retry its original immutable identity
and declaration. A definitive expired/conflicting/missing authority is terminal:
inspect and explicitly renew/reset, rather than endlessly creating identities.
A credential loss cannot be repaired by claiming the old ID with a new token.
Reset after loss must state that deletion was not verified and discard old
local usage. A human can then explicitly start a new grant/identity; no old
queue is rebound to it. Contact-based rights requests remain available, without
promising recovery from identifiers the operator never received.

Pending offline deletion retains only minimal credentials/status, without usage
or project hashes. Retry only while the tool is used or explicitly asked to
delete; no permanent worker. Keep it until acknowledged, until an explicit
local-forget decision, or until 90 days after withdrawal, whichever comes first.
After that bound show `deletion_unverified` rather than claiming remote deletion.
New opt-in while deletion is pending requires resolving it or an explicit
lost-credential/local-forget acknowledgement; it never quietly discards the
pending request. Store state in a private per-origin/tool/context directory
(0700 directory/0600 files or platform equivalent), atomically under a process
lock. Do not commit or share it in project repositories or CI caches.

## Explicit configuration precedence

Evaluate before deriving a project hash or touching usage counters:

1. A persisted withdrawal/decline, `DO_NOT_TRACK=1`, host telemetry `off`, or
   `APP_TRACKING_TELEMETRY=off` vetoes ordinary collection/upload. No environment
   enable value overrides a persisted refusal. An explicit enable operation can
   replace refusal after presenting the notice; hard environment vetoes still win.
   Reject unrecognized telemetry environment values as disabled with an
   inspectable reason. A hard veto discards unsent usage; it retains only the
   consent decision and any pending-deletion authority. A temporary environment
   veto does not silently replace the stored decision.
2. Otherwise a stored affirmative current revision permits local reporting.
   Alternatively `APP_TRACKING_CONSENT=telemetry-v1` can express an explicit
   informed decision for this process/deployment when the stored state is
   undecided. Record its source/time for registration, but do not persist a grant
   for later invocations after the environment value disappears. Boolean `1`
   or `true` is not consent. Preserve the original environment-grant declaration
   and consent timestamp with its identity for identical registration retries;
   do not rewrite the timestamp on each invocation. Its presence never enables
   a later invocation without the same valid environment value. When that value
   is absent, stop collection/upload and discard unsent usage, retaining only
   authority/decision metadata for deletion or explicit recovery. Resuming that
   same nonexpired grant reuses its identity and immutable declaration; it does
   not create an installation per invocation. An agent can set consent only
   with direct human authorization; the server cannot verify that interaction.
3. CI requires the current explicit grant **and**
   `APP_TRACKING_CI=telemetry-v1` and an isolated `APP_TRACKING_STATE_DIR` for
   this tool/CI run. Reuse within that run, never across jobs/runs or with a
   developer's local identity. Missing/invalid CI scope disables reporting.
   Separate CI counts and identities from local installation statistics.
4. A host offline setting blocks **all** networking, including registration,
   uploads, updates, and explicit deletion. It can still collect bounded local
   usage only if steps 1–3 permit it. Withdrawal/deletion controls can always
   discard local data. `DO_NOT_TRACK` does not prevent an explicit deletion
   request; offline does. Status and preview always remain local.

Host settings map into these semantics; the shared client has no repository or
project configuration that can opt a developer in. Legacy update-disable
settings keep their existing update/legacy-reporting effects and do not become
new consent. In particular, `DALO_UPDATE_CHECK=never` and
`PALAMEDES_UPDATE_CHECK=0` remain effective for update checks, while new usage
reporting requires its own affirmative decision. Migrated code must remove the
old automatic reporting path, not send both protocols. Enabling telemetry never
enables disabled updates, and disabling telemetry never disables updates.

## Queue, cadence, and command lifetime

Use the policy JSON's bounds: four MiB total local usage state, 4,096 open
counter dimensions, and 64 immutable pending batches. Prune expired usage first;
if still full, drop the oldest unsent whole batch or oldest open day. Never
change a submitted/unknown-outcome batch or merge it into a fresh ID. Local
status shows dropped-count coverage totals, which are not another wire field.
Conflicts remain bounded within that same queue until inspection, withdrawal,
or age expiry. No lossless-delivery promise is made.

Count one invocation under a nonblocking local lock; a busy/unwritable store
may omit a count without failing the command. Closing counters and queuing
immutable batches is atomic. Counters created during upload remain separate.
Current-day counts are allowed, so explicitly opted-in short CI runs need not
survive until UTC midnight. CI can explicitly flush before teardown, subject to
the same one-request budget and retry suppression; ephemeral state may still
lose the last activity.

The first ordinary upload is due after 24 hours of collecting consented usage.
Thereafter upload at most daily when the tool runs, with a bounded catch-up:
one queued batch per invocation and at least 60 seconds between attempts. If
more closed batches remain after success, the next is eligible after 60 seconds;
after draining, the next ordinary closure/upload is due 24 hours later. An
explicit flush can make closure due sooner, but cannot bypass suppression.

Registration, upload, or pending deletion is at most **one HTTP request per
invocation** with a 200 ms total client network deadline. Registration success
therefore does not send a batch in the same invocation. Run synchronously after
the host's command work, without a detached worker, upload subprocess, or daemon.
No automatic multi-request retry occurs before exit. Filesystem/scheduling time
is additional; the later client implementation must measure the resulting
latency. Concurrent invocations claim a due attempt atomically before networking.
The separate update request has its own 200 ms network budget; worst-case
combined network waiting can reach 400 ms when both are due.

For unknown outcomes, connection errors, 429, 503, and intermediary 5xx, retry
identical bytes/meaning and identity after 1 min, 5 min, 30 min, 1 h, 6 h, then
24 h, capped there. Persist the attempt/backoff claim before sending. Honor a
bounded `Retry-After` using the later deadline. A valid success resets failures;
no retry continues past local age limits. A 400/401/404/409/410/413/415 response
is terminal for that unchanged operation as specified in the API. Do not retry
an ordinary telemetry error by re-registering or silently resetting an ID.

The host preserves command stdout, JSON, stderr policy, and exit status. The
client does not print telemetry success/failure notices on ordinary commands;
status/preview expose them when requested. No telemetry failure can prevent a
version check from using its independent public cache.
