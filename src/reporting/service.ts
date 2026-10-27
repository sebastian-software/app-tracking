import { createReportingHandler } from "./handler.ts";
import { createReportingStorage } from "./storage.ts";
import { createWorkOSAuth, type WorkOSConfig } from "./auth.ts";

export function createReportingService(databaseUrl: string, config: WorkOSConfig) {
  let storage: ReturnType<typeof createReportingStorage> | undefined;
  return createReportingHandler(
    () => (storage ??= createReportingStorage(databaseUrl)),
    createWorkOSAuth(config),
  );
}
