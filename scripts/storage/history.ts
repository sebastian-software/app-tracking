import { psql, quote } from "./psql.ts";

export async function configureHistory(
  url: string,
  enabled: boolean,
  publicEnabled: boolean,
  reviewReference: string,
) {
  if (publicEnabled && !enabled) throw new Error("Public history requires enabled history");
  if (
    enabled &&
    (!reviewReference.trim() ||
      reviewReference.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(reviewReference))
  )
    throw new Error("History activation needs its disclosed policy and risk-review reference");
  await psql(
    url,
    `SELECT app_tracking.configure_history_v1(${enabled},${publicEnabled},${quote(reviewReference)})`,
  );
}

export async function runHistoryMaintenance(url: string, maxPages = 300) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 300)
    throw new Error("Invalid history budget");
  if (
    (await psql(
      url,
      "SELECT to_regprocedure('app_tracking.maintain_history_v1()') IS NOT NULL",
    )) !== "t"
  )
    return;
  for (let page = 0; page < maxPages; page++) {
    const result = await psql(
      url,
      "BEGIN; SET LOCAL statement_timeout='2500ms'; SELECT app_tracking.maintain_history_v1(); COMMIT;",
    );
    if (result === "f") return;
    if (result !== "t") throw new Error("Invalid history maintenance result");
  }
  throw new Error("History budget exhausted; committed progress is resumable");
}
