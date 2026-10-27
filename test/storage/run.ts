import { storageIntegration } from "./integration.ts";
import { ingestionIntegration } from "./ingestion.ts";
import { recoveryIntegration } from "./recovery.ts";
import { deletionIntegration } from "./deletion.ts";
import { reportingIntegration } from "./reporting.ts";
import { reportingQueryPlan } from "./reporting-plan.ts";
import { eventIntegration } from "./events.ts";
try {
  const admin = process.env.MIGRATION_DATABASE_URL,
    runtime = process.env.RUNTIME_DATABASE_URL,
    role = process.env.RUNTIME_ROLE;
  if (!admin || !runtime || !role) throw new Error("Database test configuration missing");
  console.log(JSON.stringify({ storage: await storageIntegration(admin, runtime, role) }));
  console.log(JSON.stringify({ ingestion: await ingestionIntegration(admin, runtime) }));
  console.log(JSON.stringify({ events: await eventIntegration(admin, runtime) }));
  console.log(JSON.stringify({ deletion: await deletionIntegration(admin, runtime) }));
  console.log(JSON.stringify({ recovery: await recoveryIntegration(admin, runtime) }));
  const reporter = process.env.REPORTING_DATABASE_URL,
    reportingRole = process.env.REPORTING_ROLE;
  if (reporter && reportingRole) {
    console.log(
      JSON.stringify({
        reporting: await reportingIntegration(admin, runtime, reporter, reportingRole),
      }),
    );
    console.log(JSON.stringify({ reporting_plan: await reportingQueryPlan(admin) }));
  } else
    console.log(
      JSON.stringify({
        reporting: { status: "skipped", reason: "separate reporting fixture login required" },
      }),
    );
} catch {
  console.error(
    "Database integration failed; no provider, SQL, credential, or payload details were logged.",
  );
  process.exitCode = 1;
}
