# Project website

The public explainer lives in [`site/`](../site/index.html) and is deployed to
<https://sebastian-software.github.io/app-tracking/>. It gives users of tools
such as Dalo and Palamedes a readable introduction to the implemented v1
invocation and unified-client reporting contracts. It does not establish a live service's activation status or replace
the released consumer privacy notice required by the [operations runbook](operations.md).

## Preview and verify

With the repository dependencies installed:

```sh
node scripts/check-site-browser.ts
```

Install Chromium first if needed with `pnpm exec playwright install chromium`.
The check serves the exact static files under `/app-tracking/`, exercises four
viewport sizes, checks keyboard navigation and section links without JavaScript,
audits accessibility with axe, and verifies that the page makes no external
requests or writes to browser storage. It also verifies that the page stays in
light mode under an OS dark-mode preference and that all local images load.
Screenshots go to `dist/site-evidence/`.

For an interactive local preview from the repository root:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory site
```

Open <http://127.0.0.1:8080/>. No site build or runtime dependency is needed.

## GitHub Pages deployment

The [Project website workflow](../.github/workflows/pages.yml) verifies pull
requests and deploys changes from `main`, or through a manual run on `main`.
It uploads only `site/`; service code, developer docs, private reporting UI,
and browser evidence are not part of the public site artifact. Deployment uses
the `github-pages` environment and GitHub's short-lived deployment token.

The repository's **Settings → Pages → Build and deployment → Source** must be
**GitHub Actions**. A maintainer can enable that source with:

```sh
gh api --method POST repos/sebastian-software/app-tracking/pages -f build_type=workflow
```

That command is for first-time setup. For an existing Pages site, use the
settings screen to switch its source. The workflow intentionally does not
change repository settings or deployment protections. Run **Project website**
on `main` to redeploy when only linked documentation changed.

## Link from a tool

Use the stable overview URL, or the section matching the reader's question:

- Overview: <https://sebastian-software.github.io/app-tracking/>
- Report fields: <https://sebastian-software.github.io/app-tracking/#data>
- Controls: <https://sebastian-software.github.io/app-tracking/#controls>
- Retention and processing: <https://sebastian-software.github.io/app-tracking/#privacy>
- Questions: <https://sebastian-software.github.io/app-tracking/#questions>

Keep the host's actual commands and released consent/privacy notice beside its
own opt-in flow. Linking to this overview alone does not complete that flow.

## Content and privacy boundaries

Use US English and check claims against the [consent contract](telemetry-consent.md),
[legacy wire schema](../contracts/telemetry-v1.schema.json),
[unified client](unified-client.md), [event contract](event-batches.md),
[registered product metrics](../contracts/event-catalog.json),
[retention policy](telemetry-retention.md), and [operations runbook](operations.md).
When these contracts change, review the page and its reviewed date together.
Keep proposed metrics distinct from released behavior.

The page uses local CSS, original local brand logos, a local photograph, system
fonts, and semantic HTML. It has no scripts, analytics, cookies, browser storage, forms, or
embedded third-party services. GitHub Pages processes visitor request metadata;
the page links [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
Tool telemetry uses a separate service, with Bunny and PlanetScale as described
in the v1 contracts. Do not conflate the two data flows or promise anonymous
reports, zero network metadata, or EU-only processing.

## Design and assets

The page uses a restrained information-page layout: one introduction, a field
table, and continuous text for controls, privacy, and documentation. It is light
mode only. The Software palette supplies Midnight `#002731`, Teal `#005164`,
and Frost `#e7f0f3`. The licensed corporate fonts are not redistributed; text
uses system fonts. The real wordmarks are rendered from the original SVGs.

The Software and Consulting logos are copied unchanged from the shared
`sebastian-websites/packages/ui/src/assets` originals, and the favicon from
`apps/brand/public/sebastian-software/icon-software-light.svg`. They link to
the existing English Software and Consulting sites. Consulting is a registered
trademark of Sebastian Software GmbH, rather than a separate operator of this
reporting service.

[`workspace.jpg`](../site/assets/workspace.jpg) is a decorative workspace image
generated with the built-in Imagegen tool. It depicts no actual office or team
member and carries no product or security claim. The production JPEG is resized
and compressed from the generated original. Alt text is empty because the image
adds atmosphere while the adjacent text carries the information.

The Imagegen design study and exact generation prompts are retained locally in
`dist/site-evidence/bank-design-concept.png`, `bank-design-prompt.txt`, and
`workspace-image-prompt.txt`; they are not deployed. The study informed the
restrained typography and document structure. The final design adds the user's
requested photography, icons, brand artwork, and pale color areas without cards.

The earlier [Next.js](https://nextjs.org/telemetry) and
[OpenTelemetry](https://opentelemetry.io/) references informed disclosure and
source-code navigation. No anonymity claim or third-party branding was adopted.
