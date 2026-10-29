import { readFile } from "node:fs/promises";
import { bunnyApi, required } from "./bunny.ts";
import { migrate } from "./storage/migrate.ts";
import { grantRuntime } from "./storage/grant-runtime.ts";
import { psql } from "./storage/psql.ts";
import { checkRuntime } from "./storage/check-runtime.ts";
import type { Target } from "./provision.ts";

try {
  const enabled = required("TELEMETRY_ENABLED");
  const serviceMetrics = process.env.SERVICE_METRICS_ENABLED ?? "0";
  if (![enabled, serviceMetrics].every((value) => ["0", "1"].includes(value)))
    throw new Error("Invalid activation switch");
  const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
  const api = bunnyApi(required("BUNNY_API_KEY"));
  if (enabled === "1" || serviceMetrics === "1") {
    const migration = required("MIGRATION_DATABASE_URL");
    const runtime = required("RUNTIME_DATABASE_URL");
    await migrate(migration);
    await grantRuntime(migration, await psql(runtime, "SELECT current_user"));
    // Read effective settings without exposing role names, hosts, or values.
    await checkRuntime(runtime);
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
      Name: "APP_TRACKING_DATABASE_URL",
      Secret: runtime,
    });
  }
  await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
    Name: "APP_TRACKING_TELEMETRY_ENABLED",
    Secret: enabled,
  });
  await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
    Name: "APP_TRACKING_SERVICE_METRICS_ENABLED",
    Secret: serviceMetrics,
  });
  console.log(
    JSON.stringify({
      telemetry_enabled: enabled === "1",
      service_metrics_enabled: serviceMetrics === "1",
    }),
  );
} catch {
  console.error(
    "Runtime telemetry configuration failed; no credentials or provider details were logged. Inspect permissions and effective query logging privately.",
  );
  process.exitCode = 1;
}
