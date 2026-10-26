import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseVersion(tag: string, version: string): string {
  if (!/^app-tracking-v\d+\.\d+\.\d+$/.test(tag) || tag !== `app-tracking-v${version}`) {
    throw new Error("Release tag does not match the crate version");
  }
  return version;
}

export async function publicationRequired(
  version: string,
  checksum: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(`https://crates.io/api/v1/crates/app-tracking/${version}`, {
    headers: {
      "User-Agent": "app-tracking-release (https://github.com/sebastian-software/app-tracking)",
    },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (response.status === 404) return true;
  if (response.status !== 200) throw new Error(`Registry lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    version?: { num?: string; checksum?: string; yanked?: boolean };
  };
  if (
    body.version?.num !== version ||
    body.version.checksum !== checksum ||
    body.version.yanked !== false
  ) {
    throw new Error("The published version is yanked or differs from the release package");
  }
  return false;
}

async function main(): Promise<void> {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
      encoding: "utf8",
    }),
  ) as { packages: { name: string; version: string }[]; target_directory: string };
  const crate = metadata.packages.find((item) => item.name === "app-tracking");
  if (!crate) throw new Error("Missing app-tracking crate");
  const version = releaseVersion(process.env.TAG_NAME ?? "", crate.version);
  const archive = resolve(metadata.target_directory, "package", `app-tracking-${version}.crate`);
  const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const required = await publicationRequired(version, checksum);
  if (required && process.argv.includes("--require-published")) {
    throw new Error("The release package is not available in the registry");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `publish_required=${required}\n`);
  }
  console.log(
    required ? `app-tracking ${version} needs publication` : `app-tracking ${version} is verified`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
