import { checkRustTelemetry } from "../check-rust-telemetry.ts";
import { integrationStorage } from "../../test/storage/adapter.ts";

try {
  const admin = process.env.MIGRATION_DATABASE_URL;
  const runtime = process.env.RUNTIME_DATABASE_URL;
  if (!admin || !runtime) throw new Error("Missing database configuration");
  console.log(
    JSON.stringify({ rust_client: await checkRustTelemetry(integrationStorage(runtime), admin) }),
  );
} catch (error) {
  console.error(
    error instanceof Error && error.message.startsWith("Rust telemetry integration failed at ")
      ? error.message
      : "Rust telemetry database integration failed; no credentials or payloads logged",
  );
  process.exitCode = 1;
}
