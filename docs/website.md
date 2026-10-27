# Project website

The public explanation of optional tool reporting lives at
<https://app-tracking.sebastian-software.com/> in English and
<https://app-tracking.sebastian-software.de/> in German. Its source is
[`apps/app-tracking` in sebastian-websites](https://github.com/sebastian-software/sebastian-websites/tree/main/apps/app-tracking),
where it shares the company header, footer, branding, and bilingual deployment.
The API, Rust client, reporting contracts, and activation controls remain here.

## Link from a tool

Use the overview or the section matching the reader's question:

- Overview: <https://app-tracking.sebastian-software.com/>
- Report fields: <https://app-tracking.sebastian-software.com/#data>
- Controls: <https://app-tracking.sebastian-software.com/#controls>
- Retention and processing: <https://app-tracking.sebastian-software.com/#privacy>
- Further information: <https://app-tracking.sebastian-software.com/#questions>

Use the matching `.de` host for German; section IDs are the same. Both versions
link to the official Software privacy policy's tool-reporting section:
[English](https://sebastian-software.com/privacy#tool-usage-reports) and
[German](https://sebastian-software.de/privacy#tool-usage-reports).

Keep each tool's controls and released consent/privacy notice beside its own
opt-in flow. Linking to this overview alone does not complete that flow or
establish that reporting is active.

## Maintain the website

Make content and design changes in the website monorepo. Follow its
[app-tracking operations guide](https://github.com/sebastian-software/sebastian-websites/blob/main/docs/operations/app-tracking-site.md)
for local preview, browser checks, hosting, and privacy review boundaries.
Its existing main-branch GitHub Actions deployment publishes both variants to
Bunny and manages their custom hostnames, certificates, and forced HTTPS.
DNS is managed through Bunny DNS for `.com` and Cloudflare for `.de`.

When the [consent contract](telemetry-consent.md), [unified client](unified-client.md),
[event contract](event-batches.md), [metric catalog](../contracts/event-catalog.json),
or [retention policy](telemetry-retention.md) changes, review both website
translations and the relevant privacy notices. Service activation remains
subject to the [operations runbook](operations.md).

## Compatibility with existing links

The old <https://sebastian-software.github.io/app-tracking/> address remains a
small compatibility page in [`site/`](../site/index.html). Its local script
replaces the browser history entry with the English canonical URL and preserves
the fragment, including `#data`, `#controls`, `#privacy`, and `#questions`.
Query parameters are discarded. Without JavaScript, ordinary links to both
languages remain available. The page adds no analytics, cookies, storage, or
third-party embeds. GitHub Pages still handles the initial request.

The [Project website workflow](../.github/workflows/pages.yml) verifies this
compatibility page on pull requests and deploys only `site/` from `main` through
the existing GitHub Pages environment. It does not deploy the full website.
With repository dependencies and Chromium installed, run:

```sh
node scripts/check-site-browser.ts
```

The check exercises redirects, fragment preservation, and JavaScript-disabled
links. It audits the fallback at four viewport sizes, including keyboard access,
accessibility, request destinations, cookies, and storage. Evidence is written
to `dist/site-evidence/` and is excluded from the Pages artifact.
