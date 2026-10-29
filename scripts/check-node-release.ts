import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseVersion } from "./check-crate-release.ts";

const packageName = "@sebastian-software/app-tracking";

export function productVersion(
  tag: string,
  cargo: string,
  root: { version: string },
  node: { name: string; version: string; private?: boolean },
): string {
  const version = /^version = "([^"]+)"$/m.exec(cargo)?.[1] ?? "";
  releaseVersion(tag, version);
  if (
    root.version !== version ||
    node.version !== version ||
    node.name !== packageName ||
    node.private
  ) {
    throw new Error("The release tag, Rust crate, and public Node package must share one version");
  }
  return version;
}

export async function publicationRequired(
  version: string,
  integrity: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`,
    {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  if (response.status === 404) return true;
  if (response.status !== 200) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    name?: string;
    version?: string;
    deprecated?: string;
    dist?: { integrity?: string };
  };
  if (
    body.name !== packageName ||
    body.version !== version ||
    body.dist?.integrity !== integrity ||
    body.deprecated
  ) {
    throw new Error("The published version is deprecated or differs from the release package");
  }
  return false;
}

async function main(): Promise<void> {
  const version = productVersion(
    process.env.TAG_NAME ?? "",
    readFileSync("Cargo.toml", "utf8"),
    JSON.parse(readFileSync("package.json", "utf8")),
    JSON.parse(readFileSync("packages/node-client/package.json", "utf8")),
  );
  const archive = process.argv[2];
  if (!archive || archive.startsWith("--")) throw new Error("Pass the packed npm archive path");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  const required = await publicationRequired(version, integrity);
  if (required && process.argv.includes("--require-published")) {
    throw new Error("The release package is not available in the registry");
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `publish_required=${required}\n`);
  console.log(
    required
      ? `${packageName} ${version} needs publication`
      : `${packageName} ${version} is verified`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
