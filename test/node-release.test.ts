import assert from "node:assert/strict";
import test from "node:test";
import {
  productVersion,
  publicationRequired,
  waitForPublication,
} from "../scripts/check-node-release.ts";

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

function clock() {
  let elapsed = 0;
  const waits: number[] = [];
  return {
    now: () => elapsed,
    advance(milliseconds: number) {
      elapsed += milliseconds;
    },
    waits,
    async wait(milliseconds: number) {
      waits.push(milliseconds);
      elapsed += milliseconds;
    },
  };
}

test("post-publish verification waits for npm processing and verifies the exact archive", async () => {
  const timing = clock();
  let requests = 0;
  await waitForPublication(version, integrity, {
    ...timing,
    request: async () => {
      requests++;
      return requests < 3
        ? new Response(null, { status: 404 })
        : Response.json({ name, version, dist: { integrity } });
    },
  });
  assert.equal(requests, 3);
  assert.deepEqual(timing.waits, [10_000, 10_000]);
});

test("an already visible npm release verifies without waiting", async () => {
  const timing = clock();
  await waitForPublication(version, integrity, {
    ...timing,
    request: registry(200, { name, version, dist: { integrity } }),
  });
  assert.deepEqual(timing.waits, []);
});

test("npm processing waits stop after a bounded five-minute window including lookup time", async () => {
  const timing = clock();
  let requests = 0;
  await assert.rejects(
    waitForPublication(version, integrity, {
      ...timing,
      request: async () => {
        requests++;
        timing.advance(5_000);
        return new Response(null, { status: 404 });
      },
    }),
    /still unavailable after waiting/,
  );
  assert.equal(timing.now(), 300_000);
  assert.equal(requests, 20);
});

test("post-publish verification fails immediately on registry errors or different contents", async () => {
  for (const request of [
    registry(403),
    registry(429),
    registry(503),
    registry(200, { name, version, dist: { integrity: "sha512-other" } }),
    registry(200, { name, version, dist: { integrity }, deprecated: "Retired" }),
    (async () => {
      throw new Error("network");
    }) as typeof fetch,
  ]) {
    const timing = clock();
    await assert.rejects(waitForPublication(version, integrity, { ...timing, request }));
    assert.deepEqual(timing.waits, []);
  }
});
