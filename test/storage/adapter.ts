import { createStorage, type StorageResult } from "../../src/storage/database.ts";
import type { TelemetryStorage } from "../../src/telemetry/handler.ts";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
export function integrationStorage(runtime: string): TelemetryStorage {
  if (process.env.INGESTION_HTTP_DRIVER === "1") return createStorage(runtime);
  const run = async (text: string) => ({
    result: JSON.parse(await psql(runtime, text)) as StorageResult,
    subrequests: 1,
    database_ms: 0,
  });
  return {
    registerV1(tool, id, token, revision, consented, mode) {
      return run(
        `SELECT app_tracking.register_installation_v1(${q(tool)},${q(id)},${q(token)},${q(revision)},${q(consented)},${q(mode)})`,
      );
    },
    submitV1(tool, id, token, batch, hash, revision, rows) {
      return run(
        `SELECT app_tracking.accept_batch_v1(${q(tool)},${q(id)},${q(token)},${q(batch)},${q(hash)},${q(revision)},${q(JSON.stringify(rows))}::jsonb)`,
      );
    },
    deleteV1(tool, id, token) {
      return run(`SELECT app_tracking.delete_installation_v1(${q(tool)},${q(id)},${q(token)})`);
    },
  };
}
