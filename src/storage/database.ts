import { neon, neonConfig } from "@neondatabase/serverless";
import type { EventBatch } from "../telemetry/events.ts";

// PlanetScale's documented HTTP endpoint; no WebSocket/TCP dependency at the edge.
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;
interface Trace {
  subrequests: number;
  responseStatus?: number;
}
neonConfig.fetchFunction = async (
  input: RequestInfo | URL,
  options: RequestInit & { appTrackingTrace?: Trace },
) => {
  const { appTrackingTrace, ...init } = options;
  if (appTrackingTrace) appTrackingTrace.subrequests++;
  const response = await fetch(input, init);
  if (appTrackingTrace) appTrackingTrace.responseStatus = response.status;
  return response;
};
export interface StorageResult {
  status: string;
  received_at?: string;
  error?: string;
}
export interface UsageRow {
  day: string;
  tool_version: string;
  command: string;
  count: number;
  project_id?: string;
  project_id_version?: number;
}
export class StorageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Storage operation failed");
    this.code = code;
  }
}
export function createStorage(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StorageError("configuration");
  }
  if (
    parsed.protocol !== "postgresql:" ||
    !parsed.hostname.endsWith(".pg.psdb.cloud") ||
    !parsed.username ||
    !parsed.password ||
    parsed.hash ||
    parsed.search
  ) {
    throw new StorageError("configuration");
  }
  const sql = neon(url);
  async function query(text: string, values: unknown[], signal?: AbortSignal) {
    const trace = { subrequests: 0 };
    const start = performance.now();
    try {
      const result = await sql.query(text, values, {
        fetchOptions: {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(2800)])
            : AbortSignal.timeout(2800),
          redirect: "error",
          cache: "no-store",
          appTrackingTrace: trace,
        },
      });
      return {
        result: result[0]?.result as StorageResult | null,
        subrequests: trace.subrequests,
        database_ms: performance.now() - start,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Never forward driver messages, connection data, SQL or parameters.
      throw new StorageError(
        typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unavailable",
      );
    }
  }
  return {
    setHistoryPermission(
      tool: string,
      stream: string,
      id: string,
      tokenHash: string,
      enabled: boolean,
      changedAt: number,
      signal: AbortSignal,
    ) {
      return query(
        "SELECT app_tracking.set_history_permission_v1($1,$2,$3,$4,$5,$6) AS result",
        [tool, stream, id, tokenHash, enabled, changedAt],
        signal,
      );
    },
    submitEvents(batch: EventBatch, hash: string, tokenHash: string | null, signal: AbortSignal) {
      return query(
        "SELECT app_tracking.accept_events_v1($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result",
        [
          batch.tool_id,
          batch.collection,
          batch.installation_id ?? null,
          tokenHash,
          batch.consented_at ?? null,
          batch.mode,
          batch.batch_id,
          hash,
          JSON.stringify(batch.rows),
        ],
        signal,
      );
    },
    deleteEvents(tool: string, id: string, tokenHash: string, signal: AbortSignal) {
      return query(
        "SELECT app_tracking.delete_events_v1($1,$2,$3) AS result",
        [tool, id, tokenHash],
        signal,
      );
    },
    register(
      tool: string,
      id: string,
      tokenHash: string,
      consentedAt: string,
      mode: "local" | "ci",
    ) {
      return query(
        "SELECT app_tracking.register_installation($1,$2::uuid,$3,$4,$5::timestamptz,$6) AS result",
        [tool, id, tokenHash, "telemetry-v1", consentedAt, mode],
      );
    },
    submit(
      tool: string,
      id: string,
      tokenHash: string,
      batch: string,
      hash: string,
      rows: UsageRow[],
    ) {
      return query(
        "SELECT app_tracking.accept_batch($1,$2::uuid,$3,$4::uuid,$5,$6::jsonb) AS result",
        [tool, id, tokenHash, batch, hash, JSON.stringify(rows)],
      );
    },
    registerV1(
      tool: string,
      id: string,
      tokenHash: string,
      revision: string,
      consentedAt: string,
      mode: "local" | "ci",
      signal: AbortSignal,
    ) {
      return query(
        "SELECT app_tracking.register_installation_v1($1,$2::uuid,$3,$4,$5::timestamptz,$6) AS result",
        [tool, id, tokenHash, revision, consentedAt, mode],
        signal,
      );
    },
    submitV1(
      tool: string,
      id: string,
      tokenHash: string,
      batch: string,
      hash: string,
      revision: string,
      rows: UsageRow[],
      signal: AbortSignal,
    ) {
      return query(
        "SELECT app_tracking.accept_batch_v1($1,$2::uuid,$3,$4::uuid,$5,$6,$7::jsonb) AS result",
        [tool, id, tokenHash, batch, hash, revision, JSON.stringify(rows)],
        signal,
      );
    },
    deleteV1(tool: string, id: string, tokenHash: string, signal: AbortSignal) {
      return query(
        "SELECT app_tracking.delete_installation_v1($1,$2::uuid,$3) AS result",
        [tool, id, tokenHash],
        signal,
      );
    },
    revoke(tool: string, id: string, tokenHash: string) {
      return query("SELECT app_tracking.revoke_installation($1,$2::uuid,$3) AS result", [
        tool,
        id,
        tokenHash,
      ]);
    },
  };
}
