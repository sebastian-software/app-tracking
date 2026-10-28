import { createHistoryPermissionHandler } from "./history.ts";
import { createStorage } from "../storage/database.ts";
import { createTelemetryHandler } from "./handler.ts";
import { createEventHandler } from "./events.ts";

// Explicit construction only; no environment lookup, registration, or collection
// at module load. The production composition constructs this only on a
// telemetry route while the explicit runtime switch is enabled.
export function createTelemetryService(databaseUrl: string) {
  const storage = createStorage(databaseUrl);
  const legacy = createTelemetryHandler(storage);
  const events = createEventHandler(storage);
  const history = createHistoryPermissionHandler(storage);
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/v1/history-permissions/")
      ? history(request)
      : path.startsWith("/v1/event-")
        ? events(request)
        : legacy(request);
  };
}
