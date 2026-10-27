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
  return (request: Request) =>
    new URL(request.url).pathname.startsWith("/v1/event-") ? events(request) : legacy(request);
}
