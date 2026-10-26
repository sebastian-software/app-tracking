import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const notices =
  (await readFile("THIRD_PARTY_NOTICES.md", "utf8")) +
  "\n" +
  (await readFile("STORAGE_PROOF_NOTICES.md", "utf8"));
const result = await build({
  entryPoints: ["src/telemetry/service.ts"],
  outfile: "dist/telemetry-candidate.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["browser"],
  metafile: true,
  logLevel: "info",
  banner: { js: `// SPDX-License-Identifier: MIT OR Apache-2.0\n/*\n${notices}\n*/` },
});
if (Object.values(result.metafile.outputs).some((output) => output.imports.length))
  throw new Error("Telemetry candidate must have no external runtime imports");
