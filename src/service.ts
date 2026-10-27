import { createHandler } from "./handler.ts";
import { failure } from "./telemetry/contract.ts";
import type { UpstreamOptions } from "./upstream.ts";

type Handler = (request: Request) => Promise<Response>;

// Construct storage lazily: neither startup nor any version/health request
// depends on the telemetry credential or database being available.
export function createService(
  telemetry: () => Handler | undefined,
  options: Partial<UpstreamOptions> = {},
  reporting: () => Handler | undefined = () => undefined,
): Handler {
  const version = createHandler(options);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/v1/admin/")) {
      try {
        const handle = reporting();
        return handle ? await handle(request) : failure("not_found");
      } catch {
        return failure("service_unavailable");
      }
    }
    if (
      path !== "/v1/usage-batches" &&
      !/^\/v1\/installations\/[^/]+$/.test(path) &&
      path !== "/v1/event-batches" &&
      !/^\/v1\/event-installations\/[0-9a-f]{64}$/.test(path)
    )
      return version(request);
    try {
      const handle = telemetry();
      return handle ? await handle(request) : failure("not_found");
    } catch {
      return failure("service_unavailable");
    }
  };
}
