import { runHistoryMaintenance } from "./history.ts";
import { runMaintenance } from "./maintenance.ts";
try {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Maintenance database credential missing");
  let historyFailed = false;
  try {
    await runHistoryMaintenance(url);
  } catch {
    historyFailed = true;
  }
  // History failure never extends the detail-data retention deadline.
  await runMaintenance(url);
  if (historyFailed) throw new Error("History maintenance failed");
  // This repository's Actions logs are public. Actual cleanup counts are private.
  console.log(JSON.stringify({ complete: true }));
} catch {
  console.error(
    "Retention maintenance failed or reached its budget. Inspect the workflow and last-completion health; no database or report details were logged.",
  );
  process.exitCode = 1;
}
