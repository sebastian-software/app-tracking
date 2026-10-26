import { createStorage } from "../storage/database.ts";
import { createTelemetryHandler } from "./handler.ts";

// Explicit construction only; no environment lookup, registration, or collection
// at module load. Issue #11 owns production routing and operational activation.
export function createTelemetryService(databaseUrl: string) {
  return createTelemetryHandler(createStorage(databaseUrl));
}
