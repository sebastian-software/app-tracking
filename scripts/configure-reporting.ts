import { configureHistory } from "./storage/history.ts";
import { readFile } from "node:fs/promises";
import { bunnyApi, required } from "./bunny.ts";
import type { Target } from "./provision.ts";
import { migrate } from "./storage/migrate.ts";
import { psql, quote } from "./storage/psql.ts";
import { grantReporting, prepareReportingLogin } from "./storage/grant-reporting.ts";
import { checkRuntime } from "./storage/check-runtime.ts";
import { validateWorkOSConfig } from "../src/reporting/auth.ts";
import { checkReportingRead } from "./check-reporting-read.ts";

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
    const historyEnabled = process.env.HISTORY_ENABLED === "1";
    const publicEnabled = process.env.PUBLIC_USAGE_ENABLED === "1";
    await configureHistory(
      migration,
      historyEnabled,
      publicEnabled,
      process.env.HISTORY_REVIEW_REFERENCE ?? "",
    );
    const profilesEnabled = process.env.PROFILES_ENABLED === "1";
    const profileReview = process.env.PROFILES_REVIEW_REFERENCE ?? "";
    if (
      profilesEnabled &&
      (!profileReview.trim() ||
        profileReview.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(profileReview))
    )
      throw new Error("Profile linking requires its reviewed disclosure reference");
    await psql(
      migration,
      `SELECT app_tracking.configure_profiles_v1(${profilesEnabled},${quote(profileReview)})`,
    );
    await grantReporting(migration, await prepareReportingLogin(migration, url));
    await checkRuntime(url);
    if (
      (await psql(
        url,
        "SELECT has_function_privilege(current_user,'app_tracking.admin_usage_v1(date,date,text,text)','EXECUTE') AND has_function_privilege(current_user,'app_tracking.admin_events_v1(date,date,text,text,text)','EXECUTE') AND NOT has_table_privilege(current_user,'app_tracking.event_counts_v1','SELECT') AND NOT has_table_privilege(current_user,'app_tracking.usage_counts','SELECT') AND NOT has_table_privilege(current_user,'app_tracking.reporting_installations','SELECT') AND NOT has_function_privilege(current_user,'app_tracking.register_installation_v1(text,uuid,text,text,timestamptz,text)','EXECUTE')",
      )) !== "t"
    )
      throw new Error("Reporting authority is not isolated");
    // Exercise the same HTTP driver, aggregate function, and response validator
    // as the live dashboard. Never print the returned statistics.
    await checkReportingRead(url);
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
  if (enabled === "0" && process.env.MIGRATION_DATABASE_URL) {
    const migration = process.env.MIGRATION_DATABASE_URL;
    await migrate(migration);
    await configureHistory(migration, false, false, "");
    await psql(migration, "SELECT app_tracking.configure_profiles_v1(false,'')");
  }
  for (const [Name, flag] of [
    ["APP_TRACKING_HISTORY_ENABLED", "HISTORY_ENABLED"],
    ["APP_TRACKING_PROFILES_ENABLED", "PROFILES_ENABLED"],
  ]) {
    await api("PUT", `/compute/script/${target.scriptId}/secrets`, {
      Name,
      Secret: enabled === "1" && process.env[flag!] === "1" ? "1" : "0",
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
