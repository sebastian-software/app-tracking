import { execFileSync } from "node:child_process";
import { required } from "./bunny.ts";
const run = required("RELEASE_RUN");
if (!/^\d+$/.test(run)) throw new Error("Invalid run ID");
const repo = required("GITHUB_REPOSITORY");
const metadata = JSON.parse(
  execFileSync("gh", ["api", `repos/${repo}/actions/runs/${run}`], { encoding: "utf8" }),
);
if (
  metadata.path !== ".github/workflows/deploy.yml" ||
  metadata.conclusion !== "success" ||
  metadata.head_branch !== "main"
)
  throw new Error("Rollback must use a successful main-branch release workflow");
execFileSync(
  "gh",
  ["run", "download", run, "--repo", repo, "--name", "verified-release", "--dir", "rollback"],
  { stdio: "pipe" },
);
await import("./rollback.ts");
