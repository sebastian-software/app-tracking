import { createProfileHandler } from "./profiles.ts";
import { createHistoryPermissionHandler } from "./history.ts";
import { createStorage } from "../storage/database.ts";
import { createTelemetryHandler } from "./handler.ts";
import { createEventHandler } from "./events.ts";

// Explicit construction only; no environment lookup, registration, or collection
// at module load. The production composition constructs this only on a
// telemetry route while the explicit runtime switch is enabled.
export function createTelemetryService(
  databaseUrl: string,
  options: { historyEnabled?: boolean; profilesEnabled?: boolean; publicEnabled?: boolean } = {},
) {
  const storage = createStorage(databaseUrl);
  const legacy = createTelemetryHandler(storage);
  const events = createEventHandler(storage);
  const profiles = createProfileHandler(storage, options.profilesEnabled === true);
  const history = createHistoryPermissionHandler(storage, options.historyEnabled === true);
  const publicPermission = createHistoryPermissionHandler(
    { setHistoryPermission: storage.setPublicPermission.bind(storage) },
    options.publicEnabled === true,
    "public",
  );
  return (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/v1/public-permissions/")) return publicPermission(request);
    return path.startsWith("/v1/profile-links/") || path.startsWith("/v1/shared-profiles/")
      ? profiles(request)
      : path.startsWith("/v1/history-permissions/")
        ? history(request)
        : path.startsWith("/v1/event-")
          ? events(request)
          : legacy(request);
  };
}
