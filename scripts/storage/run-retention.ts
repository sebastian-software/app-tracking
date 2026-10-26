import { runMaintenance } from "./maintenance.ts";
try {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Maintenance database credential missing");
  console.log(JSON.stringify(await runMaintenance(url)));
} catch {
  console.error(
    "Retention maintenance failed or reached its budget. Inspect the workflow and last-completion health; no database or report details were logged.",
  );
  process.exitCode = 1;
}
