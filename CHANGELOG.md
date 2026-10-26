# Changelog

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
