# Changelog

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
