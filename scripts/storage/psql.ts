import { execFile } from "node:child_process";

// Keep the connection string/password out of argv, errors, and CI output.
export function psqlEnvironment(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw new Error("Invalid database URL");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const plaintext = local && parsed.searchParams.get("sslmode") === "disable";
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: plaintext ? "disable" : "verify-full",
    PGSSLROOTCERT: plaintext ? undefined : process.env.PGSSLROOTCERT || "system",
    PGCONNECT_TIMEOUT: "10",
    PGOPTIONS: "-c timezone=UTC -c statement_timeout=10000",
  };
}
export function psql(url: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "psql",
      ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
      {
        env: psqlEnvironment(url),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // SQLSTATE is safe; SQL text, parameters and provider errors are not.
          const code = stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1];
          reject(new Error(`Database operation failed${code ? ` (${code})` : ""}`));
        } else resolve(stdout.trim());
      },
    );
    child.stdin?.end("\\set VERBOSITY verbose\n" + sql);
  });
}
export const quote = (s: string): string => "'" + s.replaceAll("'", "''") + "'";
