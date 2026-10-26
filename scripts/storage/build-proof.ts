import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const sdk = fileURLToPath(
  new URL("../esm-bunny/lib.mjs", import.meta.resolve("@bunny.net/edgescript-sdk")),
);
await mkdir("dist", { recursive: true });
const notices =
  (await readFile("THIRD_PARTY_NOTICES.md", "utf8")) +
  "\n" +
  (await readFile("STORAGE_PROOF_NOTICES.md", "utf8"));
for (const [entry, outfile] of [
  ["scripts/storage/proof-edge.ts", "dist/storage-proof.js"],
  ["scripts/storage/runtime-proof-edge.ts", "dist/runtime-proof.js"],
]) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["browser"],
    alias: { "@bunny.net/edgescript-sdk": sdk },
    define: {
      __APP_REVISION__: JSON.stringify(
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      ),
    },
    banner: { js: `// SPDX-License-Identifier: MIT OR Apache-2.0\n/*\n${notices}\n*/` },
    metafile: true,
    logLevel: "info",
  });
  if (Object.values(result.metafile.outputs).some((v) => v.imports.length))
    throw new Error("Proof bundle must be self-contained");
}
