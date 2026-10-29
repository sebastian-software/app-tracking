import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Manifest, VERSION, setLogger } = require(process.env.RELEASE_PLEASE_MODULE);
assert.equal(VERSION, "17.6.0", "Use the same Release Please version as the pinned action");
setLogger({ debug() {}, info() {}, warn() {}, error() {} });

const files = new Map(
  [
    "release-please-config.json",
    ".release-please-manifest.json",
    "Cargo.toml",
    "Cargo.lock",
    "CHANGELOG.md",
    "package.json",
    "packages/node-client/package.json",
  ].map((file) => [file, readFileSync(file, "utf8")]),
);
const config = JSON.parse(files.get("release-please-config.json"));
assert.deepEqual(Object.keys(config.packages), ["."]);
assert.equal(config.packages["."]["release-type"], "rust");
assert.ok(!config.plugins?.includes("cargo-workspace"));
const baseVersion = JSON.parse(files.get(".release-please-manifest.json"))["."];
assert.match(baseVersion, /^\d+\.\d+\.\d+$/);
const [major, minor] = baseVersion.split(".").map(Number);
const featureVersion = `${major}.${minor + 1}.0`;
const patchVersion = `${major}.${minor + 1}.1`;
const releaseSha = config["bootstrap-sha"];
assert.match(releaseSha, /^[a-f0-9]{40}$/);
const baseline = {
  sha: releaseSha,
  message: `chore(main): release app-tracking ${baseVersion}`,
  files: ["Cargo.toml"],
};
const oldFeature = {
  sha: "d".repeat(40),
  message: "feat: already published client capability",
  files: ["crates/app-tracking/src/lib.rs"],
};
const maintenance = {
  sha: "e".repeat(40),
  message: "ci: maintain release automation",
  files: ["release-please-config.json"],
};

async function plan(snapshot, commits, version = baseVersion, sha = releaseSha) {
  const github = {
    repository: { owner: "sebastian-software", repo: "app-tracking" },
    async getFileJson(file) {
      return JSON.parse(snapshot.get(file));
    },
    async getFileContentsOnBranch(file) {
      if (!snapshot.has(file))
        throw Object.assign(new Error(`Missing fixture file: ${file}`), { status: 404 });
      const parsedContent = snapshot.get(file);
      return {
        parsedContent,
        content: Buffer.from(parsedContent).toString("base64"),
        sha: "0".repeat(40),
      };
    },
    async findFilesByGlobAndRef(glob) {
      assert.equal(glob, "{apps,packages}/*/package.json");
      return [...snapshot.keys()].filter((file) =>
        /^(apps|packages)\/[^/]+\/package\.json$/.test(file),
      );
    },
    async *releaseIterator() {
      yield {
        tagName: `app-tracking-v${version}`,
        sha,
        notes: "",
        name: `app-tracking ${version}`,
      };
    },
    async *mergeCommitIterator() {
      yield* commits;
    },
    async *pullRequestIterator() {},
  };
  const manifest = await Manifest.fromManifest(github, "main");
  return manifest.buildPullRequests();
}

function apply(snapshot, candidate) {
  const updated = new Map(snapshot);
  for (const update of candidate.updates) {
    if (!updated.has(update.path) && !update.createIfMissing) continue;
    updated.set(update.path, update.updater.updateContent(updated.get(update.path)));
  }
  return updated;
}

function verifyVersions(snapshot, version) {
  assert.match(
    snapshot.get("Cargo.toml"),
    new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"),
  );
  assert.ok(snapshot.get("Cargo.lock").includes(`name = "app-tracking"\nversion = "${version}"`));
  assert.deepEqual(JSON.parse(snapshot.get(".release-please-manifest.json")), { ".": version });
  assert.ok(snapshot.get("CHANGELOG.md").includes(version));
  for (const [file, content] of snapshot) {
    if (file === "package.json" || /^(apps|packages)\/[^/]+\/package\.json$/.test(file)) {
      assert.equal(
        JSON.parse(content).version,
        version,
        `${file} must follow the Rust product version`,
      );
    }
  }
}

verifyVersions(files, baseVersion);
// The previous product release stops history collection even after changing
// the Release Please package path from crates/app-tracking to the repository root.
assert.deepEqual(await plan(files, [maintenance, baseline, oldFeature]), []);

// Exercise real Rust and JSON updaters for changes in each part of the product.
for (const file of [
  "crates/app-tracking/src/lib.rs",
  "packages/node-client/src/client.ts",
  "src/index.ts",
]) {
  const feature = {
    sha: "f".repeat(40),
    message: "feat: add a new client capability",
    files: [file],
  };
  const candidates = await plan(files, [feature, maintenance, baseline, oldFeature]);
  assert.equal(candidates.length, 1, "One product produces one release PR");
  const next = apply(files, candidates[0]);
  verifyVersions(next, featureVersion);
  assert.ok(next.get("CHANGELOG.md").includes("add a new client capability"));
  assert.ok(!next.get("CHANGELOG.md").includes("already published client capability"));

  const automatedSha = "b".repeat(40);
  const future = await plan(
    next,
    [
      {
        sha: "a".repeat(40),
        message: "fix: correct a client behavior",
        files: ["packages/node-client/src/client.ts"],
      },
      {
        sha: automatedSha,
        message: `chore(main): release app-tracking ${featureVersion}`,
        files: ["Cargo.toml"],
      },
      feature,
      baseline,
      oldFeature,
    ],
    featureVersion,
    automatedSha,
  );
  assert.equal(future.length, 1);
  verifyVersions(apply(next, future[0]), patchVersion);
}

// Future workspace packages follow the same version without another config entry.
const expanded = new Map(files);
expanded.set(
  "apps/example/package.json",
  JSON.stringify({ name: "example", version: baseVersion, private: true }),
);
const expandedPlan = await plan(expanded, [
  { sha: "c".repeat(40), message: "feat: add an example", files: ["apps/example/index.ts"] },
  baseline,
]);
assert.equal(expandedPlan.length, 1);
verifyVersions(apply(expanded, expandedPlan[0]), featureVersion);
console.log(
  `Release Please ${VERSION}: shared Rust/Node versions, release history, future followers, and subsequent patch passed`,
);
