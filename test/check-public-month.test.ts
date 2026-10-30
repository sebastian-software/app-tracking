import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkMonth, compareMonth, validateSnapshot } from "../scripts/check-public-month.ts";
import { publicUsageFixture } from "./fixtures/history.ts";

const now = Date.parse("2026-12-08T00:00:00Z");
const fixture = () => ({
  ...publicUsageFixture(),
  snapshot_at: new Date(now).toISOString(),
  series: [{ ...publicUsageFixture().series[0], month: "2026-11-01" }],
});

test("requires an eligible explicit month", () => {
  assert.throws(() => checkMonth("2026-11-01", now - 1));
  assert.throws(() => checkMonth("2026-13-01", now));
  checkMonth("2026-11-01", now);
});

test("rejects stale, malformed, and extra fields", () => {
  assert.throws(() => validateSnapshot({ ...fixture(), snapshot_at: "2026-12-07T00:00:00Z" }, now));
  assert.throws(() => validateSnapshot({ ...fixture(), secret: "forbidden" }, now));
  assert.throws(() =>
    validateSnapshot(
      { ...fixture(), series: [{ ...fixture().series[0], installation_id: "forbidden" }] },
      now,
    ),
  );
  assert.throws(() =>
    validateSnapshot({ ...fixture(), series: [{ ...fixture().series[0], count: "241" }] }, now),
  );
});

test("distinguishes missing and withheld coverage from available cells and rejects mismatches", () => {
  const available = validateSnapshot(fixture(), now);
  const empty = { ...available, series: [] };
  const withheld = {
    ...available,
    series: [{ ...available.series[0], state: "unavailable" as const, count: null }],
  };
  assert.equal(compareMonth([empty, empty, empty], "2026-11-01"), "unavailable");
  assert.equal(compareMonth([withheld, withheld, withheld], "2026-11-01"), "unavailable");
  assert.equal(compareMonth([available, available, available], "2026-11-01"), "available");
  assert.throws(() => compareMonth([available, empty, available], "2026-11-01"));
});
