import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { psql, quote } from "./psql.ts";

export async function migrate(url: string): Promise<number> {
  // One psql session/transaction serializes inspection + checksummed additive DDL.
  const files = (await readdir("db/migrations"))
    .filter((f) => /^\d{4}-[a-z-]+\.sql$/.test(f))
    .sort();
  const chunks = [
    "BEGIN; SET LOCAL ROLE postgres; SELECT pg_advisory_xact_lock(741391605);",
    "CREATE TABLE IF NOT EXISTS public.app_tracking_migrations (version text PRIMARY KEY, sha256 text NOT NULL);",
    "REVOKE ALL ON public.app_tracking_migrations FROM PUBLIC;",
  ];
  for (const file of files) {
    const source = await readFile(`db/migrations/${file}`, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    // psql conditionals keep a migration in the same transaction as its journal entry.
    chunks.push(
      `SELECT EXISTS(SELECT FROM public.app_tracking_migrations WHERE version=${quote(file)}) AS applied \\gset`,
    );
    chunks.push(
      `\\if :applied\nDO $check$ BEGIN IF NOT EXISTS (SELECT FROM public.app_tracking_migrations WHERE version=${quote(file)} AND sha256=${quote(hash)}) THEN RAISE EXCEPTION 'migration_checksum_mismatch'; END IF; END $check$;\n\\else\n${source}\nINSERT INTO public.app_tracking_migrations VALUES (${quote(file)}, ${quote(hash)});\n\\endif`,
    );
  }
  chunks.push("COMMIT;");
  await psql(url, chunks.join("\n"));
  return files.length;
}
if (import.meta.main) {
  try {
    const url = process.env.MIGRATION_DATABASE_URL;
    if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
    console.log(JSON.stringify({ migrations: await migrate(url) }));
  } catch {
    console.error(
      "Migration failed; inspect the database privately. No provider details were logged.",
    );
    process.exitCode = 1;
  }
}
