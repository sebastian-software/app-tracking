import { psql } from "./psql.ts";
try {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Operations credential missing");
  const healthy = await psql(
    url,
    `SELECT
    COALESCE(last_completed_at > clock_timestamp()-interval '3 hours',false)
    AND NOT EXISTS(SELECT FROM app_tracking.reporting_installations
      WHERE purge_pending AND transitioned_at < clock_timestamp()-interval '1 hour')
    FROM app_tracking.maintenance_state WHERE singleton`,
  );
  if (healthy !== "t") throw new Error("Maintenance or deletion is overdue");
  console.log(JSON.stringify({ retention_recent: true, deletion_backlog_healthy: true }));
} catch {
  console.error(
    "Telemetry operations check failed: database unavailable, retention older than three hours, or deletion pending over one hour. No identifiers or database details were logged.",
  );
  process.exitCode = 1;
}
