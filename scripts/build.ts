import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// 0.13.0 ships a Bunny-specific entry without Node server dependencies. Resolve
// it from the locked local package, so deployment needs no runtime CDN imports.
const sdk = fileURLToPath(
  new URL("../esm-bunny/lib.mjs", import.meta.resolve("@bunny.net/edgescript-sdk")),
);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
await mkdir("dist", { recursive: true });
for (const [name, entry] of [
  ["edge", "src/edge.ts"],
  ["service", "src/handler.ts"],
]) {
  const result = await build({
    entryPoints: [entry],
    outfile: `dist/${name}.js`,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    define: { __APP_REVISION__: JSON.stringify(revision) },
    alias: { "@bunny.net/edgescript-sdk": sdk },
    banner: {
      js: `// SPDX-License-Identifier: MIT OR Apache-2.0\n${name !== "service" ? `/*\n${notices}\n*/` : ""}`,
    },
    metafile: true,
    logLevel: "info",
  });
  if (Object.values(result.metafile.outputs).some((output) => output.imports.length > 0)) {
    throw new Error("The deployment bundle must have no external imports");
  }
  await writeFile(`dist/${name}.meta.json`, JSON.stringify(result.metafile, null, 2) + "\n");
}
