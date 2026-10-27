import { readFile } from "node:fs/promises";
import { bunnyApi, required } from "./bunny.ts";
import type { Target } from "./provision.ts";
import { migrate } from "./storage/migrate.ts";
import { psql } from "./storage/psql.ts";
import { grantReporting } from "./storage/grant-reporting.ts";
import { checkRuntime } from "./storage/check-runtime.ts";

try {
  const enabled = required("REPORTING_ENABLED");
  if (!["0", "1"].includes(enabled)) throw new Error("Invalid reporting switch");
  const api = bunnyApi(required("BUNNY_API_KEY"));
  const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
  if (enabled === "1") {
    const migration = required("MIGRATION_DATABASE_URL"),
      url = required("REPORTING_DATABASE_URL"),
      hashes = required("ADMIN_TOKEN_HASHES");
    if (
      hashes.split(",").length > 8 ||
      hashes.split(",").some((value) => !/^[0-9a-f]{64}$/.test(value))
    )
      throw new Error("Invalid reporting credential hashes");
    await migrate(migration);
    await grantReporting(migration, await psql(url, "SELECT current_user"));
    await checkRuntime(url);
    if (
      (await psql(
        url,
        "SELECT has_function_privilege(current_user,'app_tracking.admin_usage_v1(date,date,text,text)','EXECUTE') AND NOT has_table_privilege(current_user,'app_tracking.usage_counts','SELECT') AND NOT has_table_privilege(current_user,'app_tracking.reporting_installations','SELECT') AND NOT has_function_privilege(current_user,'app_tracking.register_installation_v1(text,uuid,text,text,timestamptz,text)','EXECUTE')",
      )) !== "t"
    )
      throw new Error("Reporting authority is not isolated");
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
      Name: "APP_TRACKING_REPORTING_DATABASE_URL",
      Secret: url,
    });
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
      Name: "APP_TRACKING_ADMIN_TOKEN_HASHES",
      Secret: hashes,
    });
  }
  await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
    Name: "APP_TRACKING_REPORTING_ENABLED",
    Secret: enabled,
  });
  console.log(JSON.stringify({ reporting_enabled: enabled === "1" }));
} catch {
  console.error(
    "Reporting configuration failed; no keys, credentials, or provider details were logged.",
  );
  process.exitCode = 1;
}
