import { createReportingHandler } from "./handler.ts";
import { createReportingStorage } from "./storage.ts";

export function createReportingService(databaseUrl: string, tokenHashes: string[]) {
  let storage: ReturnType<typeof createReportingStorage> | undefined;
  return createReportingHandler(
    () => (storage ??= createReportingStorage(databaseUrl)),
    tokenHashes,
  );
}
