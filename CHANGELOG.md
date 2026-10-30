# Changelog

## [0.6.1](https://github.com/sebastian-software/app-tracking/compare/app-tracking-v0.6.0...app-tracking-v0.6.1) (2026-10-30)


### Bug Fixes

* **deps:** update actions/checkout action to v7 ([#75](https://github.com/sebastian-software/app-tracking/issues/75)) ([1e9039a](https://github.com/sebastian-software/app-tracking/commit/1e9039ac7c0b9d767819d998ffca383c9d5e6816))
* **deps:** update actions/configure-pages action to v6 ([#76](https://github.com/sebastian-software/app-tracking/issues/76)) ([253ebe9](https://github.com/sebastian-software/app-tracking/commit/253ebe9200359a834512010d5460ae6a986d2088))
* **deps:** update actions/deploy-pages action to v5 ([#77](https://github.com/sebastian-software/app-tracking/issues/77)) ([8e1a30c](https://github.com/sebastian-software/app-tracking/commit/8e1a30c5d20e6cea81cc52f45eef69659cd662de))
* **deps:** update actions/setup-node action to v7 ([#78](https://github.com/sebastian-software/app-tracking/issues/78)) ([2c1f116](https://github.com/sebastian-software/app-tracking/commit/2c1f1169103ab863e1ee57623d79544a760fa307))
* **deps:** update actions/upload-artifact action to v7 ([#79](https://github.com/sebastian-software/app-tracking/issues/79)) ([50c5907](https://github.com/sebastian-software/app-tracking/commit/50c59071020ce042cf52d150980ce0fe8550d5f1))
* **deps:** update actions/upload-pages-artifact action to v5 ([#80](https://github.com/sebastian-software/app-tracking/issues/80)) ([b9073a0](https://github.com/sebastian-software/app-tracking/commit/b9073a0eb73879b7f9a85fabeae04acd047fcac7))
* **deps:** update pnpm to v12 ([#81](https://github.com/sebastian-software/app-tracking/issues/81)) ([e990c34](https://github.com/sebastian-software/app-tracking/commit/e990c340f73ede03b84541396d4dfb8d024043c5))
* **deps:** update pnpm/action-setup action to v6 ([#82](https://github.com/sebastian-software/app-tracking/issues/82)) ([f70429f](https://github.com/sebastian-software/app-tracking/commit/f70429fe873285c5c2bbd03f16acff9f2d0ae05a))
* **deps:** update rust-lang/crates-io-auth-action to v1.0.6 ([#74](https://github.com/sebastian-software/app-tracking/issues/74)) ([9fe6a9f](https://github.com/sebastian-software/app-tracking/commit/9fe6a9f544ae929f2dab58eb291558eb201ba7af))

## [0.6.0](https://github.com/sebastian-software/app-tracking/compare/app-tracking-v0.5.0...app-tracking-v0.6.0) (2026-10-29)


### Features

* add a pure TypeScript Node.js client ([90cf48d](https://github.com/sebastian-software/app-tracking/commit/90cf48de887d6ca1f455227cc91d43950fa7631f))
* add aggregate service statistics and consent reminders ([#69](https://github.com/sebastian-software/app-tracking/issues/69)) ([4eb69df](https://github.com/sebastian-software/app-tracking/commit/4eb69dfccd06b1b2151581f08b5d0ea020a6dcb2))


### Bug Fixes

* version and release Rust and Node clients together ([b403244](https://github.com/sebastian-software/app-tracking/commit/b40324467c40803633ebf4941b3e475b620f6464))

## [0.5.0](https://github.com/sebastian-software/app-tracking/compare/app-tracking-v0.4.0...app-tracking-v0.5.0) (2026-10-28)


### Features

* add separately permitted 24-month usage history ([#62](https://github.com/sebastian-software/app-tracking/issues/62)) ([030815c](https://github.com/sebastian-software/app-tracking/commit/030815c763218bf77e662b631eadc3824c334636))
* add separately permitted cross-tool profile linking ([#64](https://github.com/sebastian-software/app-tracking/issues/64)) ([e2d1556](https://github.com/sebastian-software/app-tracking/commit/e2d1556006e8176983999e367304df07583cac3d))
* publish reusable additional consent notices ([#65](https://github.com/sebastian-software/app-tracking/issues/65)) ([fc28104](https://github.com/sebastian-software/app-tracking/commit/fc281040eebba5325fd954aac8e99797f7f6b0e8))
* require separate consent for public usage totals ([#66](https://github.com/sebastian-software/app-tracking/issues/66)) ([a9f3906](https://github.com/sebastian-software/app-tracking/commit/a9f390662010a1fc9413802f7cbae30ec723f479))

## [0.4.0](https://github.com/sebastian-software/app-tracking/compare/app-tracking-v0.3.0...app-tracking-v0.4.0) (2026-10-27)


### Features

* ship unified Rust tracking and verified downloads ([#56](https://github.com/sebastian-software/app-tracking/issues/56)) ([8f60d40](https://github.com/sebastian-software/app-tracking/commit/8f60d40e8264cf894f59a1ea56119f278b0a9dc9))

## [0.3.0](https://github.com/sebastian-software/app-tracking/releases/tag/app-tracking-v0.3.0) (2026-10-26)

### Features

- Add bounded background telemetry delivery through `run_in_background` and
  `run_background_worker`. The command persists counts and returns without
  waiting for network delivery or worker completion.
- Preserve consent, offline controls, immutable batches, retry backoff, and
  generation-safe acknowledgements. The worker has a five-second request
  deadline; synchronous APIs and independent update checks remain available.

### Bug Fixes

- Isolate standard streams and Windows handle inheritance so captured command
  output can close while the telemetry worker finishes.

### Validation

- Add real-process regression coverage on Linux, macOS, and Windows, including
  execution from a path containing spaces.

This entry and the GitHub release backfill the already published crate at
`app-tracking-v0.3.0`. Earlier versions were published manually; Release Please
maintains subsequent entries.
