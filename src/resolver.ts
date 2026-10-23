import { versionPath, type Distribution } from "./catalog.ts";
import type { Release } from "./contract.ts";
import { fetchRelease, type UpstreamOptions } from "./upstream.ts";

export const FRESH_SECONDS = 3_600;
export const MAX_AGE_SECONDS = 86_400;
export const FAILURE_BACKOFF_SECONDS = 60;

export interface CheckedRelease {
  release: Release;
  checkedAt: number;
}

interface State {
  cached?: CheckedRelease;
  pending?: Promise<CheckedRelease | undefined>;
  retryAt: number;
}

export function createResolver(options: UpstreamOptions) {
  // Only catalog entries reach this map: neither hosts nor request fields grow it.
  const states = new Map<string, State>();
  const usable = (cached: CheckedRelease | undefined, maxAge: number) => {
    if (!cached) return undefined;
    const age = options.now() - cached.checkedAt;
    return age >= 0 && age < maxAge * 1_000 ? cached : undefined;
  };

  return async function resolve(entry: Distribution): Promise<CheckedRelease | undefined> {
    const key = versionPath(entry);
    let state = states.get(key);
    if (!state) {
      state = { retryAt: 0 };
      states.set(key, state);
    }
    const fresh = usable(state.cached, FRESH_SECONDS);
    if (fresh) return fresh;
    if (state.pending) return state.pending;
    if (options.now() < state.retryAt) return usable(state.cached, MAX_AGE_SECONDS);

    const current = state;
    current.pending = (async () => {
      try {
        const checked = await fetchRelease(entry, options);
        if (!current.cached || checked.checkedAt >= current.cached.checkedAt)
          current.cached = checked;
        // A stale upstream CDN hit is still stale; avoid fetching it on every
        // invocation while its background refresh is in progress.
        current.retryAt = usable(current.cached, FRESH_SECONDS)
          ? 0
          : options.now() + FAILURE_BACKOFF_SECONDS * 1_000;
        return current.cached;
      } catch {
        current.retryAt = options.now() + FAILURE_BACKOFF_SECONDS * 1_000;
        return usable(current.cached, MAX_AGE_SECONDS);
      } finally {
        current.pending = undefined;
      }
    })();
    return current.pending;
  };
}
