import { readFile } from "node:fs/promises";
import { bunnyApi, required } from "./bunny.ts";
import type { Target } from "./provision.ts";
import { migrate } from "./storage/migrate.ts";
import { psql } from "./storage/psql.ts";
import { grantReporting, prepareReportingLogin } from "./storage/grant-reporting.ts";
import { checkRuntime } from "./storage/check-runtime.ts";
import { validateWorkOSConfig } from "../src/reporting/auth.ts";
import { createReportingStorage, reportingFailureLabel } from "../src/reporting/storage.ts";
import { checkedUsage, type UsageQuery } from "../src/reporting/contract.ts";

try {
  const enabled = required("REPORTING_ENABLED");
  if (!["0", "1"].includes(enabled)) throw new Error("Invalid reporting switch");
  const api = bunnyApi(required("BUNNY_API_KEY"));
  const target: Target = JSON.parse(await readFile(".deployment/target.json", "utf8"));
  if (enabled === "1") {
    const migration = required("MIGRATION_DATABASE_URL"),
      url = required("REPORTING_DATABASE_URL");
    const config = {
      clientId: required("WORKOS_CLIENT_ID"),
      apiKey: required("WORKOS_API_KEY"),
      organizationId: required("WORKOS_ORGANIZATION_ID"),
      cookiePassword: required("WORKOS_COOKIE_PASSWORD"),
      issuer: required("WORKOS_ISSUER"),
      origin: target.base,
    };
    validateWorkOSConfig(config);
    await migrate(migration);
    await grantReporting(migration, await prepareReportingLogin(migration, url));
    await checkRuntime(url);
    if (
      (await psql(
        url,
        "SELECT has_function_privilege(current_user,'app_tracking.admin_usage_v1(date,date,text,text)','EXECUTE') AND NOT has_table_privilege(current_user,'app_tracking.usage_counts','SELECT') AND NOT has_table_privilege(current_user,'app_tracking.reporting_installations','SELECT') AND NOT has_function_privilege(current_user,'app_tracking.register_installation_v1(text,uuid,text,text,timestamptz,text)','EXECUTE')",
      )) !== "t"
    )
      throw new Error("Reporting authority is not isolated");
    // Exercise the same HTTP driver, aggregate function, and response validator
    // as the live dashboard. Never print the returned statistics.
    const until = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(until) - 86400000).toISOString().slice(0, 10);
    const query: UsageQuery = { from, until, tool: "all", mode: "local" };
    let readStage = "storage";
    try {
      const result = await createReportingStorage(url).usage(query, AbortSignal.timeout(2800));
      readStage = "contract";
      checkedUsage(result, query);
    } catch (error) {
      console.error(
        "Reporting read check failed: " + readStage + ":" + reportingFailureLabel(error),
      );
      throw new Error("Reporting read check failed");
    }
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
      Name: "APP_TRACKING_REPORTING_DATABASE_URL",
      Secret: url,
    });
    const authSecrets = {
      APP_TRACKING_WORKOS_CLIENT_ID: config.clientId,
      APP_TRACKING_WORKOS_API_KEY: config.apiKey,
      APP_TRACKING_WORKOS_ORGANIZATION_ID: config.organizationId,
      APP_TRACKING_WORKOS_COOKIE_PASSWORD: config.cookiePassword,
      APP_TRACKING_WORKOS_ISSUER: config.issuer,
      APP_TRACKING_REPORTING_ORIGIN: config.origin,
    };
    for (const [Name, Secret] of Object.entries(authSecrets))
      await api("PUT", `/compute/script/${target.scriptId}/secrets`, { Name, Secret });
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
