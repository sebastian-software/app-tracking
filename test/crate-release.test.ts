import assert from "node:assert/strict";
import test from "node:test";
import { publicationRequired, releaseVersion } from "../scripts/check-crate-release.ts";

const version = "0.3.0";
const checksum = "a".repeat(64);

function registry(status: number, body: unknown = {}): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

test("release tags must identify the packaged crate version", () => {
  assert.equal(releaseVersion("app-tracking-v0.3.0", version), version);
  for (const tag of [
    "v0.3.0",
    "app-tracking-v0.2.1",
    "app-tracking-v0.3.0; echo unexpected",
    "main",
  ]) {
    assert.throws(() => releaseVersion(tag, version));
  }
});

test("only an explicit not-found response permits publication", async () => {
  assert.equal(await publicationRequired(version, checksum, registry(404)), true);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publicationRequired(version, checksum, registry(status)), /lookup failed/);
  }
  await assert.rejects(
    publicationRequired(version, checksum, async () => {
      throw new Error("network");
    }),
  );
});

test("recovery skips only the same unyanked package", async () => {
  const entry = { num: version, checksum, yanked: false };
  assert.equal(
    await publicationRequired(version, checksum, registry(200, { version: entry })),
    false,
  );
  for (const value of [
    {},
    { ...entry, num: "0.2.1" },
    { ...entry, checksum: "b".repeat(64) },
    { ...entry, yanked: true },
    { ...entry, yanked: undefined },
  ]) {
    await assert.rejects(publicationRequired(version, checksum, registry(200, { version: value })));
  }
});
