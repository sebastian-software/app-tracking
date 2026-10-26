import type { createStorage } from "../storage/database.ts";
import {
  batch,
  canonicalBatch,
  failure,
  policy,
  record,
  registration,
  reply,
  sha256,
  statuses,
  TelemetryError,
  uuid7,
  type ErrorCode,
} from "./contract.ts";
import { abortable, readJSON, readEmptyBody } from "./json.ts";

export type TelemetryStorage = Pick<
  ReturnType<typeof createStorage>,
  "registerV1" | "submitV1" | "deleteV1"
>;
const encoder = new TextEncoder();
// Exported for integration tests and future gated composition only. The production
// version entry point deliberately does not import or enable this handler.
export function createTelemetryHandler(storage: TelemetryStorage) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const installation = /^\/v1\/installations\/([^/]+)$/.exec(url.pathname);
    const submit = url.pathname === "/v1/usage-batches";
    if (!installation && !submit) return failure("not_found");
    if (url.search || url.hash || request.url.includes("?") || request.url.includes("#"))
      return failure("invalid_request");
    if (installation && !uuid7.test(installation[1])) return failure("invalid_request");
    const deleting = !!installation && request.method === "DELETE";
    const allowed = installation ? "PUT, DELETE" : "POST";
    if (!(installation ? ["PUT", "DELETE"] : ["POST"]).includes(request.method))
      return failure("method_not_allowed", { Allow: allowed });
    let headerBytes = 0;
    for (const [name, value] of request.headers) {
      if (headerBytes + name.length + value.length + 4 > policy.max_header_bytes)
        return failure("invalid_request");
      headerBytes += encoder.encode(`${name}: ${value}\r\n`).length;
    }
    if (headerBytes > policy.max_header_bytes || request.headers.has("cookie"))
      return failure("invalid_request");
    if (
      (!deleting &&
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        )) ||
      request.headers.has("content-encoding")
    )
      return failure("unsupported_media_type");
    const credential = /^Bearer ([0-9a-f]{64})$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (!credential) return failure("unauthorized");
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(policy.server_request_deadline_ms),
    ]);
    try {
      if (deleting && installation) {
        await readEmptyBody(request, signal);
        const id = installation[1];
        const tokenHash = await sha256(`app-tracking-token-v1\n${id}\n${credential}`);
        if (signal.aborted) throw new TelemetryError("service_unavailable");
        // Older Dalo clients predate the multi-tool deletion header.
        const tool = request.headers.get("App-Tracking-Tool") ?? "dalo";
        if (!Object.hasOwn(policy.tools, tool)) return failure("unsupported_tool");
        const { result } = await abortable(storage.deleteV1(tool, id, tokenHash, signal), signal);
        const outcome = checkedResult(result);
        if (outcome.status !== "deleted") throw new TelemetryError("service_unavailable");
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      const input = await readJSON(
        request,
        installation ? policy.max_registration_bytes : policy.max_batch_bytes,
        signal,
      );
      if (installation) {
        const body = registration(input);
        const id = installation[1];
        const tokenHash = await sha256(`app-tracking-token-v1\n${id}\n${credential}`);
        if (signal.aborted) throw new TelemetryError("service_unavailable");
        const { result } = await abortable(
          storage.registerV1(
            body.tool_id,
            id,
            tokenHash,
            body.consent_revision,
            body.consented_at,
            body.mode,
            signal,
          ),
          signal,
        );
        const outcome = checkedResult(result);
        if (outcome.status !== "registered" && outcome.status !== "duplicate")
          throw new TelemetryError("service_unavailable");
        return reply(
          { schema_version: 1, installation_id: id, status: outcome.status },
          outcome.status === "registered" ? 201 : 200,
        );
      }
      const body = batch(input);
      const hash = await sha256(canonicalBatch(body));
      const tokenHash = await sha256(
        `app-tracking-token-v1\n${body.installation_id}\n${credential}`,
      );
      if (signal.aborted) throw new TelemetryError("service_unavailable");
      const { result } = await abortable(
        storage.submitV1(
          body.tool_id,
          body.installation_id,
          tokenHash,
          body.batch_id,
          hash,
          body.consent_revision,
          body.rows,
          signal,
        ),
        signal,
      );
      const outcome = checkedResult(result);
      if (
        (outcome.status !== "accepted" && outcome.status !== "duplicate") ||
        typeof outcome.received_at !== "string" ||
        !Number.isFinite(Date.parse(outcome.received_at))
      )
        throw new TelemetryError("service_unavailable");
      return reply({
        schema_version: 1,
        installation_id: body.installation_id,
        batch_id: body.batch_id,
        status: outcome.status,
        payload_sha256: hash,
        received_at: new Date(outcome.received_at).toISOString(),
      });
    } catch (error) {
      // No request data, driver messages, exceptions, tokens, or SQL reach logs/responses.
      return failure(error instanceof TelemetryError ? error.code : "service_unavailable");
    }
  };
}
function checkedResult(result: unknown): Record<string, unknown> {
  if (!record(result)) throw new TelemetryError("service_unavailable");
  if (Object.hasOwn(result, "error")) {
    const code = result.error;
    if (typeof code === "string" && Object.hasOwn(statuses, code))
      throw new TelemetryError(code as ErrorCode);
    throw new TelemetryError("service_unavailable");
  }
  return result;
}
