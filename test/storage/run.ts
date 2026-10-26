import { storageIntegration } from "./integration.ts";
import { ingestionIntegration } from "./ingestion.ts";
import { recoveryIntegration } from "./recovery.ts";
import { deletionIntegration } from "./deletion.ts";
try {
  const admin = process.env.MIGRATION_DATABASE_URL,
    runtime = process.env.RUNTIME_DATABASE_URL,
    role = process.env.RUNTIME_ROLE;
  if (!admin || !runtime || !role) throw new Error("Database test configuration missing");
  console.log(JSON.stringify({ storage: await storageIntegration(admin, runtime, role) }));
  console.log(JSON.stringify({ ingestion: await ingestionIntegration(admin, runtime) }));
  console.log(JSON.stringify({ deletion: await deletionIntegration(admin, runtime) }));
  console.log(JSON.stringify({ recovery: await recoveryIntegration(admin, runtime) }));
} catch {
  console.error(
    "Database integration failed; no provider, SQL, credential, or payload details were logged.",
  );
  process.exitCode = 1;
}
