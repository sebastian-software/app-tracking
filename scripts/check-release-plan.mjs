import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Manifest, VERSION, setLogger } = require(process.env.RELEASE_PLEASE_MODULE);
assert.equal(VERSION, "17.6.0", "Use the same Release Please version as the pinned action");
setLogger({ debug() {}, info() {}, warn() {}, error() {} });

const path = "crates/app-tracking";
const files = new Map(
  [
    "release-please-config.json",
    ".release-please-manifest.json",
    "Cargo.toml",
    "Cargo.lock",
    `${path}/Cargo.toml`,
    `${path}/CHANGELOG.md`,
  ].map((file) => [file, readFileSync(file, "utf8")]),
);
const config = JSON.parse(files.get("release-please-config.json"));
const baseVersion = JSON.parse(files.get(".release-please-manifest.json"))[path];
assert.match(baseVersion, /^\d+\.\d+\.\d+$/);
const [major, minor] = baseVersion.split(".").map(Number);
const featureVersion = `${major}.${minor + 1}.0`;
const patchVersion = `${major}.${minor + 1}.1`;
const floor = config["last-release-sha"];
assert.ok(floor, "Keep a baseline for the rewritten manual release commit");
const manualSha = "cce58849e115c29486c10795c415b2fe13a1823f";
const feature = {
  sha: "f".repeat(40),
  message: "feat: add a new client capability",
  files: [`${path}/src/lib.rs`],
};
const maintenance = {
  sha: "e".repeat(40),
  message: "ci: maintain release automation",
  files: ["release-please-config.json"],
};
const baseline = {
  sha: floor,
  message: "fix: already shipped in manual 0.3.0",
  files: [`${path}/src/lib.rs`],
};
const oldFeature = {
  sha: "d".repeat(40),
  message: "feat: already published background delivery",
  files: [`${path}/src/lib.rs`],
};

async function plan(snapshot, commits, version = baseVersion, releaseSha = manualSha) {
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
      assert.equal(glob, path);
      return [path];
    },
    async *releaseIterator() {
      yield {
        tagName: `app-tracking-v${version}`,
        sha: releaseSha,
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
    snapshot.get(`${path}/Cargo.toml`),
    new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"),
  );
  assert.ok(snapshot.get("Cargo.lock").includes(`name = "app-tracking"\nversion = "${version}"`));
  assert.equal(JSON.parse(snapshot.get(".release-please-manifest.json"))[path], version);
  assert.match(snapshot.get(`${path}/CHANGELOG.md`), new RegExp(version.replaceAll(".", "\\.")));
  assert.equal(
    snapshot.get("Cargo.toml"),
    files.get("Cargo.toml"),
    "Never run a package updater on the virtual root",
  );
}

// The manual tag's SHA is absent from rebased main. The equivalent commit is
// the historical floor, so already shipped features must not produce a release.
assert.deepEqual(await plan(files, [maintenance, baseline, oldFeature]), []);

// Exercise actual strategies, plugins, and every generated updater. A schema
// check alone cannot catch the virtual-workspace package-updater failure.
const legacy = new Map(files);
legacy.set(
  "release-please-config.json",
  JSON.stringify({ ...config, plugins: [], packages: { ".": config.packages[path] } }),
);
legacy.set(".release-please-manifest.json", JSON.stringify({ ".": baseVersion }));
legacy.set("CHANGELOG.md", files.get(`${path}/CHANGELOG.md`));
const broken = await plan(legacy, [feature, maintenance, baseline, oldFeature]);
assert.equal(broken.length, 1);
assert.throws(() => apply(legacy, broken[0]), /not a package manifest/);

const candidates = await plan(files, [feature, maintenance, baseline, oldFeature]);
assert.equal(candidates.length, 1);
const next = apply(files, candidates[0]);
verifyVersions(next, featureVersion);
assert.ok(!candidates[0].updates.some((update) => update.path === "Cargo.toml"));

// Once an automated release exists, its newer SHA wins over the historical
// floor. A fix produces a patch without replaying that release's feature.
const automatedSha = "b".repeat(40);
const future = await plan(
  next,
  [
    {
      sha: "a".repeat(40),
      message: "fix: correct a new client behavior",
      files: [`${path}/src/lib.rs`],
    },
    {
      sha: automatedSha,
      message: `chore(main): release app-tracking ${featureVersion}`,
      files: [`${path}/Cargo.toml`],
    },
    feature,
    maintenance,
    baseline,
    oldFeature,
  ],
  featureVersion,
  automatedSha,
);
assert.equal(future.length, 1);
verifyVersions(apply(next, future[0]), patchVersion);
console.log(
  `Release Please ${VERSION}: manual baseline, virtual workspace updates, and subsequent release passed`,
);
