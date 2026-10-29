import type { Distribution } from "./catalog.ts";

export type VersionStatus = 200 | 304 | 503;
export interface VersionObservation {
  tool: string;
  distribution: string;
  channel: string;
  status: VersionStatus;
}
export type VersionObserver = (observation: VersionObservation) => void;
export interface ServiceMetricsStorage {
  countVersionRequest(observation: VersionObservation, signal: AbortSignal): Promise<unknown>;
}

// Only catalog values and response categories cross this boundary. Never pass a
// Request, URL, client address, header, or reporting identity to storage.
export function observeVersion(
  request: Request,
  entry: Distribution,
  status: VersionStatus,
  observer?: VersionObserver,
) {
  if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") return;
  try {
    observer?.({
      tool: entry.tool,
      distribution: entry.distribution,
      channel: entry.channel,
      status,
    });
  } catch {
    // Optional statistics must never change update availability.
  }
}

export function createServiceMetrics(
  storage: () => ServiceMetricsStorage | undefined,
  waitUntil: (work: Promise<unknown>) => void,
): VersionObserver {
  let pending = 0;
  return (observation) => {
    // Bound optional work during an outage. There is no request-level queue or
    // retry: an unknown commit outcome must not be counted twice.
    if (pending >= 8) return;
    pending++;
    const work = Promise.resolve()
      .then(() => storage()?.countVersionRequest(observation, AbortSignal.timeout(1000)))
      .catch(() => undefined)
      .finally(() => {
        pending--;
      });
    waitUntil(work);
  };
}
