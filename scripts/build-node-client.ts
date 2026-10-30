import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, "packages/node-client");
const dist = join(directory, "dist");
await mkdir(join(dist, "types"), { recursive: true });
for (const format of ["cjs", "esm"] as const) {
  const result = await build({
    entryPoints: [join(directory, "src/index.ts")],
    outfile: join(dist, format === "cjs" ? "index.cjs" : "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format,
    define: { __WORKER_PATH__: "__appWorkerPath" },
    banner: {
      js:
        format === "esm"
          ? "import { createRequire as __appRequire } from 'node:module'; import { fileURLToPath as __appWorkerURL } from 'node:url'; const require = __appRequire(import.meta.url); const __appWorkerPath = __appWorkerURL(new URL('./worker.cjs', import.meta.url));"
          : "const __appWorkerPath = require('node:path').join(__dirname, 'worker.cjs');",
    },
    metafile: true,
  });
  const builtins = ["fs", "path", "assert", "util", "os", "events", "stream", "constants"];
  if (
    Object.values(result.metafile.outputs).some((output) =>
      output.imports.some(
        (item) => !item.path.startsWith("node:") && !builtins.includes(item.path),
      ),
    )
  )
    throw new Error("Node client contains a non-built-in runtime dependency");
}
await build({
  entryPoints: [join(directory, "src/worker.ts")],
  outfile: join(dist, "worker.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { __WORKER_PATH__: "''" },
});
// Consumer tests use the real receiver contract without native TypeScript support.
// Keep this fixture outside the published package.
await build({
  entryPoints: [join(root, "test/fixtures/node-event-validator.ts")],
  outfile: join(root, "dist/node-client-test/event-validator.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
await build({
  entryPoints: [join(root, "test/fixtures/node-update-contract.ts")],
  outfile: join(root, "dist/node-client-test/update-contract.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
const declarations = spawnSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", join(directory, "tsconfig.json")],
  { cwd: root, stdio: "inherit" },
);
if (declarations.status !== 0) throw new Error("Node client declaration build failed");
for (const name of [
  "index",
  "client",
  "types",
  "download",
  "permissions",
  "update",
  "update-contract",
  "cli",
])
  await copyFile(
    join(dist, "declarations/packages/node-client/src", `${name}.d.ts`),
    join(dist, "types", `${name}.d.ts`),
  );
await rm(join(dist, "declarations"), { recursive: true });
for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
  await copyFile(join(root, license), join(directory, license));
let notices = "# Bundled JavaScript dependency notices\n\n";
const lockRequire = createRequire(import.meta.resolve("proper-lockfile"));
for (const name of ["proper-lockfile", "graceful-fs", "retry", "signal-exit"]) {
  const packageRoot = dirname(lockRequire.resolve(`${name}/package.json`));
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const license = (await readdir(packageRoot)).find((file) =>
    /^licen[cs]e(?:\.md|\.txt)?$/i.test(file),
  );
  if (!license) throw new Error(`Missing license for ${name}`);
  notices += `## ${name} ${metadata.version}\n\n${await readFile(join(packageRoot, license), "utf8")}\n\n`;
}
await writeFile(join(directory, "THIRD_PARTY_NOTICES.md"), notices);
