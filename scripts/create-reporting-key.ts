import { randomBytes } from "node:crypto";
import { writeFile, realpath } from "node:fs/promises";
import { resolve, relative, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adminTokenHash } from "../src/reporting/handler.ts";

const output = process.argv[2];
if (!output) throw new Error("Pass a new private output file outside the checkout");
const path = resolve(await realpath(dirname(resolve(output))), basename(output));
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const within = relative(root, path);
if (!within.startsWith(`..${sep}`))
  throw new Error("Reporting keys must stay outside the checkout");
const token = `at_admin_v1_${randomBytes(32).toString("hex")}`;
await writeFile(
  path,
  JSON.stringify({ token, token_sha256: await adminTokenHash(token) }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  "A reporting key and its hash were written to the new private file. No key was logged.",
);
