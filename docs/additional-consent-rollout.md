# Additional usage permissions

Implementation review: October 28, 2026. This records product behavior and legal
information for implementation; it is not a legal opinion or certification.

## Scope and applicability

Sebastian Software GmbH is the existing German controller. The existing service
notice identifies its privacy contact, Bunny API hosting, PlanetScale storage in
Frankfurt, transfer safeguards, rights, backup boundary, and 90-day detail limit.
No new processor, account identifier, hardware identifier, or advertising purpose
is introduced by these permissions.

| Processing               | Applicable basis and implementation                                                  | Release requirement                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Ordinary opt-in usage    | Existing Article 6(1)(a) GDPR and section 25(1) TDDDG notice                         | Keep the existing grant separate; an upgrade never grants expanded fields                 |
| Monthly history          | Separate affirmative consent, 24 months after month end; future-only eligibility     | Released history notice, affirmative revision, separate withdrawal, exact acknowledgement |
| Cross-tool profile links | Separate affirmative consent for local-use overlap analysis, with random local state | Separate choice per tool, private file, future-only eligibility, unlink and global reset  |
| Public usage totals      | Additional disclosure and publication assessment                                     | Remains disabled; history or linking consent does not authorize publication               |

The SDK exports `HISTORY_NOTICE` and `PROFILE_NOTICE` for notice-only settings
commands. Its interactive dialogs use those identical strings. They identify the
controller and purpose, data and retention, optional nature, withdrawal, pending
offline changes, and the official privacy anchor. A host must also show its exact
commands before accepting a choice. Environment flags, ordinary grants, shared
files, CI authorization, installation hooks, and upgrades grant neither scope.
History and publication choices store their disclosure revision. A missing or unknown revision
never reuses an affirmative choice; refusal and withdrawal remain possible.

## Internal-use assessment

Monthly summaries extend storage and permit observations after detail expiry.
Installation/project counts are monthly uniques, not people counts. Minimum
populations and contribution limits reduce disclosure; they do not establish
anonymity. Withdrawal invalidates entire potentially affected months. There is
no retained contribution ledger, and an expired source prevents recomputation.
The private view must show unavailable months rather than fabricate zeroes.

Profile linking introduces correlation across tools and therefore needs a choice
beyond ordinary reporting. The shared identifier cannot prove a person or device.
Private random state, distinct credentials, local-only participation, future-only
joins, bounded links, and unlink/reset reduce its scope. Profile reads remain
WorkOS-protected and confined to retained detail. Neither identifiers nor overlap
statistics enter the public projection. Reset removes links; ordinary authenticated
deletion removes that tool's reports. These are different controls.

The feature gates reject new positive choices while off but allow withdrawals and
resets. Enabling internal features does not authorize any consumer to enroll a
person silently. Dalo and Ferriki adoption remains deferred. The [publication assessment](public-usage-consent.md) records external knowledge,
differencing, repeated releases, and downstream-copy risks. Screening alone does
not establish anonymity. Publication uses only separately permitted contributions.

## Release verification

1. Publish the official English/German notice at `/privacy#tool-usage-history`
   and `/privacy#tool-usage-profiles`, linked from the app-tracking overview.
2. Publish an SDK release containing the same disclosure text and revision-aware
   history state. Verify its published artifact before pinning a consumer.
3. A participating consumer shows the complete ordinary notice before a fresh
   expanded-field grant. Retain authenticated old-stream inspection/deletion;
   never import an older grant into the unified client.
4. Expose notice-only, affirmative, refusal, status, withdrawal, retry, unlink,
   and shared-reset controls without an ordinary-command prompt. Preview/status
   send nothing. A new installation can remain pending until its ordinary
   identity is registered by an accepted event batch; do not invent a usage
   event to register it.
5. Verify offline refusals and pending withdrawals, CI/DNT vetoes, exact
   acknowledgement, upgrade behavior, and unchanged command output/counting.
6. Record the released evidence before enabling the internal gates. Record a separate publication assessment before enabling its gate. History and
   public coverage begin at the next
   full UTC month; no historical backfill or immediate month totals are implied.

## Primary sources checked

- [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj): Articles 5, 6(1)(a), 7,
  13 and 17 govern purpose, optional consent, information, withdrawal, and erasure.
- [EDPB Guidelines 05/2020, version 1.1](https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_202005_consent_en.pdf):
  sections 3.1.3, 3.2, 3.3 and 5.2 address granular purposes, informed choices and
  withdrawal. Checked October 28, 2026.
- [Section 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html):
  prior informed consent for optional device storage/access. Checked October 28, 2026. The implementation does not claim a necessary-service exemption.
