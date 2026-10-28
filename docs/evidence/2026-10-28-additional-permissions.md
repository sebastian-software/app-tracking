# Additional-permission activation evidence

Verified October 28, 2026 UTC. This records implementation and release evidence,
not legal certification or a claim of anonymous data.

## Released components

- Service changes: [PR #65](https://github.com/sebastian-software/app-tracking/pull/65)
  and [PR #66](https://github.com/sebastian-software/app-tracking/pull/66).
- Registry SDK: `app-tracking = "=0.5.0"`, published by
  [release run 40782049666](https://github.com/sebastian-software/app-tracking/actions/runs/40782049666).
  Cargo metadata confirmed a registry dependency, with checksum
  `ee74f98b29fc2b3e29d7096a345c2a264a10d5d43645281af9f64b12d825bd48`.
- Official notices: [website PR #104](https://github.com/sebastian-software/sebastian-websites/pull/104),
  deployed by [run 40782212847](https://github.com/sebastian-software/sebastian-websites/actions/runs/40782212847).
  Both English and German `/privacy` responses contained distinct
  `tool-usage-history`, `tool-usage-profiles`, and `tool-usage-public` anchors.
  Both app-tracking overview variants link to those notices.
- Palamedes consumer controls: [PR #1454](https://github.com/sebastian-software/palamedes/pull/1454),
  source `9d8e6d964dadc1bc432f0912fe33a2727bf06618`. A fresh ordinary expanded-field
  choice precedes three independent additional choices. Existing grants retain
  their scope. This evidence does not assert that a published Palamedes package
  already includes these controls; its normal consumer release is separate.

## Production configuration

[Activation run 40783011480](https://github.com/sebastian-software/app-tracking/actions/runs/40783011480)
succeeded at service revision `4038485ffbd4686c3dc3e11100798aeb393c669a`.

| Repository variable                 | Value |
| ----------------------------------- | ----- |
| `APP_TRACKING_HISTORY_ENABLED`      | `1`   |
| `APP_TRACKING_PUBLIC_USAGE_ENABLED` | `1`   |
| `APP_TRACKING_PROFILES_ENABLED`     | `1`   |

The history/public review reference points to the released
[publication assessment](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.5.0/docs/public-usage-consent.md).
The profile reference points to the released
[additional-consent assessment](https://github.com/sebastian-software/app-tracking/blob/app-tracking-v0.5.0/docs/additional-consent-rollout.md).
These references document scope and limits; a nonempty reference is not automatic
legal approval. Both runtime and storage gates reject unauthorized positive grants.

History and public coverage start on November 1, 2026. The first full month is
November, with finalization no earlier than December 8, 2026 UTC. Thresholds may
still suppress it. No earlier usage or ordinary grants are backfilled. Detailed
reports remain limited to 90 days; summaries last at most 24 months after month end.

## Owned live consumer proof

A local Palamedes build with the validated production endpoint and the registry
SDK used an isolated private home/state directory. It exercised only its own
synthetic installation. The ordinary failed `report` invocation counted once;
no synthetic registration event was invented by the integration.

The proof observed:

- An accepted ordinary batch before additional settings synchronization.
- Separate exact acknowledgements for history, publication, and profile linking.
- Publication withdrawal while ordinary reporting and private history remained granted.
- Tool-scoped profile unlinking while independent reporting/history remained granted.
- A fresh profile grant followed by shared reset, without deleting ordinary reports.
- History withdrawal and acknowledged authenticated deletion of ordinary contributions.
- No fixture identifiers, credentials, payloads, or private reporting values in the result log.

A prior source-build fixture stayed offline because the package build had replaced
its debug executable. It was not treated as a successful live test. Its retained
local authority subsequently received an authenticated absence acknowledgement and
was removed. The successful proof used an immutable copy of the configured binary;
all owned temporary profiles were removed after deletion acknowledgement. Minimal
server revocation/reset records follow the documented 90-day lifecycle.

## Public response boundary

Two consecutive requests to each URL returned HTTP 200, `Cache-Control: no-store`,
no CDN cache hit, and an empty `series`:

- `https://sebastian-app-tracking.b-cdn.net/v1/public/usage`
- `https://sebastian-oss-metrics.b-cdn.net/v1/app-usage.json`
- `https://metrics.sebastian-software.com/v1/app-usage.json`

An empty series means no eligible finalized month exists, not zero adoption.
The public population requires its own permission and independent screening.
Its retained data contains only rounded totals, without identifiers, unique counts,
or detailed breakdowns. Thresholds and rounding do not prove anonymity; external
copies cannot be recalled. The notice explains that boundary before publication consent.

## Remaining evidence

- Release the prepared Palamedes controls through its normal release process.
- Verify the first eligible scheduled complete-month finalization, then inspect its
  actual coverage and suppression state before describing it as a usage measurement.
- Dalo, Ferriki, and Node SDK interoperability remain deferred; this rollout does
  not claim their consumer adoption or Rust/Node lifecycle proof.
