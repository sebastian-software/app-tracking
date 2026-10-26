import { createStorage } from "../storage/database.ts";
import { createTelemetryHandler } from "./handler.ts";

// Explicit construction only; no environment lookup, registration, or collection
// at module load. The production composition constructs this only on a
// telemetry route while the explicit runtime switch is enabled.
export function createTelemetryService(databaseUrl: string) {
  return createTelemetryHandler(createStorage(databaseUrl));
}
