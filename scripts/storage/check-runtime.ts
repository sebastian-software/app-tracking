import { psql } from "./psql.ts";

export async function checkRuntime(runtime: string) {
  const privateQueries = await psql(
    runtime,
    `SELECT
    current_setting('log_statement')='none'
    AND current_setting('log_min_duration_statement')='-1'
    AND current_setting('log_min_duration_sample')='-1'
    AND current_setting('log_parameter_max_length_on_error')='0'`,
  );
  if (privateQueries !== "t") throw new Error("Runtime query logging needs review");
}
if (import.meta.main) {
  try {
    const runtime = process.env.RUNTIME_DATABASE_URL;
    if (!runtime) throw new Error("Runtime credential missing");
    await checkRuntime(runtime);
    console.log(JSON.stringify({ runtime_query_logging_private: true }));
  } catch {
    console.error(
      "Runtime query logging verification failed; no role, connection, or parameter details were logged.",
    );
    process.exitCode = 1;
  }
}
