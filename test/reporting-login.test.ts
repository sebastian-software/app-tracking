import assert from "node:assert/strict";
import test from "node:test";
import { reportingLoginRole, prepareReportingLogin } from "../scripts/storage/grant-reporting.ts";

test("reporting login resolves local and PlanetScale routing usernames without exposing credentials", () => {
  assert.equal(reportingLoginRole("postgresql://reporter@localhost/app_tracking"), "reporter");
  assert.equal(
    reportingLoginRole("postgresql://pscale_api_fixture.route@region.pg.psdb.cloud/app_tracking"),
    "pscale_api_fixture",
  );
  for (const value of [
    "https://reporter@localhost/app_tracking",
    "postgresql://@localhost/app_tracking",
    "postgresql://reporter.route@localhost/app_tracking",
    "postgresql://pscale_api_fixture.route.extra@region.pg.psdb.cloud/app_tracking",
    "postgresql://bad%22role@localhost/app_tracking",
    "postgresql://pscale_api_fixture.@region.pg.psdb.cloud/app_tracking",
  ])
    assert.throws(() => reportingLoginRole(value));
});

test("reporting bootstrap rejects a different logical database before connecting", async () => {
  await assert.rejects(
    prepareReportingLogin(
      "postgresql://migrator@localhost/app_tracking",
      "postgresql://reporter@localhost/other_app",
    ),
    /scope does not match/,
  );
});
