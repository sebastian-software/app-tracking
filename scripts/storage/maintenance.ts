import { psql } from "./psql.ts";
import { record, policy } from "../../src/telemetry/contract.ts";

export async function runMaintenance(
  url: string,
  maxPages = policy.maintenance_max_pages,
  batchSize = policy.maintenance_page_rows,
) {
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > policy.maintenance_max_pages ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > policy.maintenance_page_rows
  )
    throw new Error("Invalid maintenance budget");
  const totals = {
    pages: 0,
    usage_deleted: 0,
    receipts_deleted: 0,
    quotas_deleted: 0,
    installations_expired: 0,
    tombstones_deleted: 0,
    complete: false,
  };
  for (let page = 0; page < maxPages; page++) {
    const value: unknown = JSON.parse(
      await psql(
        url,
        `BEGIN; SET LOCAL statement_timeout='2500ms'; SELECT app_tracking.maintain_v1(${batchSize}); COMMIT;`,
      ),
    );
    if (
      !record(value) ||
      typeof value.more !== "boolean" ||
      typeof value.busy !== "boolean" ||
      value.busy
    )
      throw new Error("Maintenance could not make progress");
    for (const key of [
      "usage_deleted",
      "receipts_deleted",
      "quotas_deleted",
      "installations_expired",
      "tombstones_deleted",
    ] as const) {
      const count = value[key];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > batchSize)
        throw new Error("Invalid maintenance result");
      totals[key] += count;
    }
    totals.pages++;
    if (!value.more) {
      totals.complete = true;
      return totals;
    }
  }
  throw new Error("Maintenance budget exhausted; committed progress is resumable");
}
