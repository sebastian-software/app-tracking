import assert from "node:assert/strict";
import test from "node:test";
import { monthQuery, monthStatus } from "../scripts/check-history-month.ts";
import { historyFixture } from "./fixtures/history.ts";

const query = monthQuery(["2026-11-01", "palamedes", "legacy", "cli.invocation", "local"]);

test("month verification accepts only an explicit completed or cohort-suppressed period", () => {
  const fixture = historyFixture(query);
  const row = fixture.months[0]!;
  for (const [state, reason, complete] of [
    ["pending", "late_arrival", false],
    ["incomplete", "source_expired", false],
    ["incomplete", "missing_finalizer", false],
    ["expired", "expired", false],
    ["disabled", "disabled", false],
    ["suppressed", "cohort", true],
  ] as const) {
    row.state = state;
    row.reason = reason;
    row.data = null;
    assert.equal(monthStatus(fixture, query).complete, complete);
  }
  row.state = "finalized";
  row.reason = "ready";
  row.data = {
    count: "240",
    monthly_installations: "24",
    monthly_projects: "20",
    breakdowns: [],
    suppressed_breakdowns: [],
  };
  assert.equal(monthStatus(fixture, query).complete, true);
  fixture.enabled = false;
  assert.equal(monthStatus(fixture, query).complete, false);
  fixture.enabled = true;
  fixture.period.coverage_from = "2026-12-01";
  assert.equal(monthStatus(fixture, query).complete, false);
  fixture.months = [];
  assert.throws(() => monthStatus(fixture, query));
});

test("month verification requires one valid tool and whole month", () => {
  assert.equal(query.until, "2026-12-01");
  assert.throws(() => monthQuery(["2026-11-01", "all", "legacy", "cli.invocation", "local"]));
  assert.throws(() => monthQuery(["2026-02-30", "palamedes", "legacy", "cli.invocation", "local"]));
  assert.throws(() => monthQuery(["2026-11-01", "ferriki", "legacy", "cli.invocation", "local"]));
});
