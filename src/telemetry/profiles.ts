import { abortable, readJSON } from "./json.ts";
import { failure, reply, record, sha256, TelemetryError } from "./contract.ts";
export const PROFILE_REVISION = "profile-linking-v1";
export interface ProfileStorage {
  setProfileLink(
    tool: string,
    id: string,
    tokenHash: string,
    enabled: boolean,
    changedAt: number,
    profileId: string | null,
    profileTokenHash: string | null,
    signal: AbortSignal,
  ): Promise<{ result: unknown }>;
  resetProfile(
    profileId: string,
    tokenHash: string,
    signal: AbortSignal,
  ): Promise<{ result: unknown }>;
}
export function createProfileHandler(storage: ProfileStorage, enabled = true) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const link = /^\/v1\/profile-links\/events\/([0-9a-f]{64})$/.exec(url.pathname);
    const profile = /^\/v1\/shared-profiles\/([0-9a-f]{64})$/.exec(url.pathname);
    if (!link && !profile) return failure("not_found");
    const method = link ? "PUT" : "DELETE";
    if (request.method !== method) return failure("method_not_allowed", { Allow: method });
    if (
      url.search ||
      url.hash ||
      request.url.includes("?") ||
      request.headers.has("cookie") ||
      request.headers.has("content-encoding") ||
      [...request.headers].reduce(
        (n, [key, value]) => n + new TextEncoder().encode(key + ": " + value + "\r\n").length,
        0,
      ) > 16384
    )
      return failure("invalid_request");
    const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return failure("unauthorized");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
    try {
      let result: unknown;
      let expected: Record<string, unknown>;
      if (link) {
        const tool = request.headers.get("App-Tracking-Tool");
        if (!tool || !["ardo", "dalo", "palamedes", "ferriki"].includes(tool))
          return failure("invalid_request");
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") ?? "",
          )
        )
          return failure("unsupported_media_type");
        const body = await readJSON(request, 2048, signal);
        if (
          !record(body) ||
          Object.keys(body).sort().join() !==
            "changed_at,enabled,profile_id,profile_token,revision,schema_version" ||
          body.schema_version !== 1 ||
          body.revision !== PROFILE_REVISION ||
          typeof body.enabled !== "boolean" ||
          !Number.isSafeInteger(body.changed_at) ||
          Number(body.changed_at) < 0 ||
          (body.enabled
            ? typeof body.profile_id !== "string" ||
              !/^[0-9a-f]{64}$/.test(body.profile_id) ||
              typeof body.profile_token !== "string" ||
              !/^[0-9a-f]{64}$/.test(body.profile_token)
            : body.profile_id !== null || body.profile_token !== null)
        )
          return failure("invalid_request");
        if (body.enabled && !enabled) return failure("not_found");
        const profileId = body.profile_id as string | null;
        const profileHash = body.enabled
          ? await sha256(`app-tracking-profile-v1\n${profileId}\n${body.profile_token}`)
          : null;
        ({ result } = await abortable(
          storage.setProfileLink(
            tool,
            link[1]!,
            await sha256(token),
            body.enabled,
            Number(body.changed_at),
            profileId,
            profileHash,
            signal,
          ),
          signal,
        ));
        expected = {
          schema_version: 1,
          revision: PROFILE_REVISION,
          enabled: body.enabled,
          changed_at: body.changed_at,
          profile_id: profileId,
        };
      } else {
        if (request.body !== null) {
          const reader = request.body.getReader();
          try {
            for (;;) {
              const part = await abortable(reader.read(), signal);
              if (part.done) break;
              if (part.value.byteLength) return failure("invalid_request");
            }
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        ({ result } = await abortable(
          storage.resetProfile(
            profile![1]!,
            await sha256(`app-tracking-profile-v1\n${profile![1]}\n${token}`),
            signal,
          ),
          signal,
        ));
        expected = {
          schema_version: 1,
          revision: PROFILE_REVISION,
          profile_id: profile![1],
          status: "deleted",
        };
      }
      if (!record(result)) return failure("service_unavailable");
      if ("error" in result) {
        const code = result.error;
        if (
          code === "count_limit" ||
          code === "not_found" ||
          code === "unauthorized" ||
          code === "installation_revoked" ||
          code === "installation_not_found" ||
          code === "registration_conflict" ||
          code === "invalid_request"
        )
          return failure(code);
        return failure("service_unavailable");
      }
      if (
        link
          ? result.status !== "updated" ||
            result.enabled !== expected.enabled ||
            result.changed_at !== expected.changed_at ||
            result.profile_id !== expected.profile_id
          : result.status !== "deleted"
      )
        return failure("service_unavailable");
      return reply(expected);
    } catch (error) {
      return failure(error instanceof TelemetryError ? error.code : "service_unavailable");
    }
  };
}
