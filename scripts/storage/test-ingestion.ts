import { migrate } from "./migrate.ts";
import { grantRuntime } from "./grant-runtime.ts";
import { psql } from "./psql.ts";
import { ingestionIntegration } from "../../test/storage/ingestion.ts";
import { deletionIntegration } from "../../test/storage/deletion.ts";
try {
  const admin = process.env.MIGRATION_DATABASE_URL,
    runtime = process.env.RUNTIME_DATABASE_URL;
  if (!admin || !runtime) throw new Error("Database configuration missing");
  await migrate(admin);
  // Ask the authenticated database for the exact role instead of guessing from
  // the provider's routing suffix or exposing the managed username in CI output.
  const role = await psql(runtime, "SELECT current_user");
  await grantRuntime(admin, role);
  console.log(JSON.stringify({ ingestion: await ingestionIntegration(admin, runtime) }));
  console.log(JSON.stringify({ deletion: await deletionIntegration(admin, runtime) }));
} catch {
  console.error(
    "Live ingestion test failed; inspect privately. No provider or payload details were logged.",
  );
  process.exitCode = 1;
}
