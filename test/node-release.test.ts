import assert from "node:assert/strict";
import test from "node:test";
import { productVersion, publicationRequired } from "../scripts/check-node-release.ts";

const name = "@sebastian-software/app-tracking";
const version = "0.6.0";
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const cargo = `[package]\nname = "app-tracking"\nversion = "${version}"\n`;

function registry(status: number, body: unknown = {}): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

test("npm publishing requires the same product version as the tag and Rust crate", () => {
  assert.equal(
    productVersion(`app-tracking-v${version}`, cargo, { version }, { name, version }),
    version,
  );
  for (const node of [
    { name, version: "0.1.0" },
    { name, version, private: true },
    { name: "other", version },
  ]) {
    assert.throws(() => productVersion(`app-tracking-v${version}`, cargo, { version }, node));
  }
  assert.throws(() => productVersion("app-tracking-v0.5.0", cargo, { version }, { name, version }));
  assert.throws(() =>
    productVersion(`app-tracking-v${version}`, cargo, { version: "0.5.0" }, { name, version }),
  );
});

test("npm recovery publishes only after an explicit 404", async () => {
  assert.equal(await publicationRequired(version, integrity, registry(404)), true);
  for (const status of [401, 403, 409, 429, 500, 503]) {
    await assert.rejects(
      publicationRequired(version, integrity, registry(status)),
      /lookup failed/,
    );
  }
  await assert.rejects(
    publicationRequired(version, integrity, async () => {
      throw new Error("network");
    }),
  );
});

test("npm recovery skips only the identical non-deprecated archive", async () => {
  const entry = { name, version, dist: { integrity } };
  assert.equal(await publicationRequired(version, integrity, registry(200, entry)), false);
  for (const body of [
    {},
    { ...entry, version: "0.5.0" },
    { ...entry, name: "other" },
    { ...entry, dist: {} },
    { ...entry, deprecated: "Retired" },
  ]) {
    await assert.rejects(publicationRequired(version, integrity, registry(200, body)));
  }
});
