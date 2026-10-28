import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { configureHistory, runHistoryMaintenance } from "../../scripts/storage/history.ts";
import {
  checkedHistory,
  checkedPublicUsage,
  type HistoryQuery,
} from "../../src/reporting/history.ts";

export async function historyIntegration(admin: string, runtime: string, reporter: string) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(admin).hostname))
    throw new Error("History fixtures require disposable local storage");
  const sql = (text: string) => psql(admin, text);
  assert.equal(await sql("SELECT count(*) FROM app_tracking.history_periods_v1"), "0");
  assert.equal(
    await sql("SELECT enabled FROM app_tracking.history_policy_v1 WHERE singleton"),
    "f",
  );
  const month = await sql(
    "SELECT (date_trunc('month',CURRENT_DATE)-CASE WHEN extract(day FROM CURRENT_DATE)>=8 THEN interval '1 month' ELSE interval '2 months' END)::date",
  );
  const until = await sql(`SELECT (${q(month)}::date+interval '1 month')::date`);
  const oldMonth = await sql("SELECT (date_trunc('month',CURRENT_DATE)-interval '6 months')::date");
  const ids = Array.from({ length: 20 }, () => randomBytes(32).toString("hex"));
  const token = "a".repeat(64);
  const finalize = () =>
    sql(
      `SELECT app_tracking.finalize_history_v1(${q(month)},'ferriki','events','language.use','local')`,
    );
  const query: HistoryQuery = {
    from: month,
    until,
    tool: "ferriki",
    stream: "events",
    metric: "language.use",
    mode: "local",
  };
  const history = async () =>
    checkedHistory(
      JSON.parse(
        await psql(
          reporter,
          `SELECT app_tracking.admin_history_v1(${q(month)},${q(until)},'ferriki','events','language.use','local')`,
        ),
      ),
      query,
    );
  const publicUsage = async () =>
    JSON.parse(await psql(reporter, "SELECT app_tracking.public_usage_v1()"));
  try {
    assert.equal(await finalize(), "disabled");
    assert.equal((await publicUsage()).error, "not_found");
    assert.equal((await history()).months[0]!.state, "disabled");
    await assert.rejects(configureHistory(admin, true, false, ""));
    await configureHistory(admin, true, false, "synthetic-history-review");
    assert.equal(
      await sql(
        "SELECT coverage_from>date_trunc('month',CURRENT_DATE) FROM app_tracking.history_policy_v1 WHERE singleton",
      ),
      "t",
    );
    // Explicit fixture coverage is synthetic; production activation cannot backfill a partial month.
    await sql(
      `UPDATE app_tracking.history_policy_v1 SET coverage_from=${q(month)} WHERE singleton`,
    );
    for (const [i, id] of ids.entries()) {
      const project = (i + 1).toString(16).padStart(64, "0");
      await sql(`INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode)
        VALUES('ferriki',${q(id)},${q(token)},extract(epoch FROM (${q(oldMonth)}::date)::timestamptz)::bigint*1000,'local');
        INSERT INTO app_tracking.event_batches_v1(tool_id,batch_id,content_hash,collection,installation_id,mode)
        VALUES('ferriki',${q(id)},${q(token)},'opt_in',${q(id)},'local');
        INSERT INTO app_tracking.event_counts_v1 VALUES('ferriki',${q(id)},1,${q(month)}::date-date '1970-01-01','language.use',${q(i < 10 ? "1.0.0" : "2.0.0")},'{"language":"rust","source":"explicit"}',NULL,10,${q(project)},1);`);
    }
    // Existing usage permission alone never makes rows eligible for history.
    assert.equal(
      JSON.parse(
        await sql(
          `SELECT app_tracking.history_candidate_v1(${q(month)},'ferriki','events','language.use','local')`,
        ),
      ).state,
      "suppressed",
    );
    const permissionAt = Number(
      await sql(`SELECT extract(epoch FROM (${q(month)}::date-1)::timestamptz)::bigint*1000`),
    );
    for (const id of ids) {
      const granted = JSON.parse(
        await psql(
          runtime,
          `SELECT app_tracking.set_history_permission_v1('ferriki','events',${q(id)},${q(token)},true,${permissionAt})`,
        ),
      );
      assert.equal(granted.status, "updated");
    }
    // Client timestamps cannot backdate eligibility before the acknowledgement.
    assert.equal(
      JSON.parse(
        await sql(
          `SELECT app_tracking.history_candidate_v1(${q(month)},'ferriki','events','language.use','local')`,
        ),
      ).state,
      "suppressed",
    );
    assert.equal(
      await sql(
        "SELECT bool_and(eligible_from=CURRENT_DATE+1) FROM app_tracking.history_permissions_v1",
      ),
      "t",
    );
    // Only the disposable fixture may simulate permissions acknowledged before this month.
    await sql(`UPDATE app_tracking.history_permissions_v1 SET eligible_from=${q(month)}`);
    await sql(`UPDATE app_tracking.event_counts_v1 SET count=1000 WHERE batch_id=${q(ids[0]!)}`);
    let candidate = JSON.parse(
      await sql(
        `SELECT app_tracking.history_candidate_v1(${q(month)},'ferriki','events','language.use','local')`,
      ),
    );
    assert.equal(candidate.state, "suppressed");
    assert.equal(candidate.data, null);
    await sql(`UPDATE app_tracking.event_counts_v1 SET count=10 WHERE batch_id=${q(ids[0]!)}`);
    candidate = JSON.parse(
      await sql(
        `SELECT app_tracking.history_candidate_v1(${q(month)},'ferriki','events','language.use','local')`,
      ),
    );
    assert.equal(candidate.state, "finalized");
    assert.equal(candidate.data.count, "200");
    assert.equal(candidate.data.monthly_installations, "20");
    assert.equal(candidate.data.monthly_projects, "20");
    assert.ok(candidate.data.suppressed_breakdowns.includes("version_family"));
    assert.ok(!JSON.stringify(candidate.data).includes('"value":"1.0"'));
    assert.equal(await finalize(), "finalized");
    const before = await sql("SELECT finalized_at FROM app_tracking.history_periods_v1");
    assert.equal(await finalize(), "finalized");
    assert.equal(await sql("SELECT finalized_at FROM app_tracking.history_periods_v1"), before);
    let value = await history();
    assert.equal(value.months[0]!.data!.count, "200");
    for (const id of ids) assert.ok(!JSON.stringify(value).includes(id));
    // The public gate is independent of private persistence.
    assert.equal((await publicUsage()).error, "not_found");
    await configureHistory(admin, true, true, "synthetic-history-review");
    // An operator switch and old history grants cannot authorize publication.
    assert.deepEqual(checkedPublicUsage(await publicUsage()).series, []);
    await sql(
      `UPDATE app_tracking.history_policy_v1 SET public_coverage_from=${q(month)} WHERE singleton`,
    );
    assert.equal(await finalize(), "finalized");
    assert.equal(checkedPublicUsage(await publicUsage()).series[0]!.count, null);
    const publicChoice = (id: string, enabled: boolean, at: number, suppliedToken = token) =>
      psql(
        runtime,
        `SELECT app_tracking.set_public_permission_v1('ferriki','events',${q(id)},${q(suppliedToken)},${enabled},${at})`,
      ).then(JSON.parse);
    assert.equal(
      (await publicChoice(ids[0]!, true, permissionAt, "b".repeat(64))).error,
      "unauthorized",
    );
    for (const id of ids)
      assert.equal((await publicChoice(id, true, permissionAt)).status, "updated");
    assert.equal(
      await sql(
        "SELECT bool_and(eligible_from=CURRENT_DATE+1) FROM app_tracking.public_permissions_v1",
      ),
      "t",
    );
    // Backdated client choices never include earlier reports.
    assert.equal(
      JSON.parse(
        await sql(
          `SELECT app_tracking.public_candidate_v1(${q(month)},'ferriki','events','language.use','local')`,
        ),
      ).state,
      "suppressed",
    );
    // Only disposable synthetic fixtures simulate pre-month acknowledgements.
    await sql(
      `UPDATE app_tracking.public_permissions_v1 SET eligible_from=${q(month)}; DELETE FROM app_tracking.public_periods_v1;`,
    );
    assert.equal(await finalize(), "finalized");
    assert.equal(checkedPublicUsage(await publicUsage()).series[0]!.count, "200");
    assert.deepEqual(JSON.parse(await sql("SELECT data FROM app_tracking.public_periods_v1")), {
      count: "200",
    });
    assert.equal((await publicChoice(ids[0]!, false, permissionAt + 1)).status, "updated");
    assert.equal(checkedPublicUsage(await publicUsage()).series[0]!.count, null);
    assert.equal((await history()).months[0]!.data!.count, "200");
    assert.equal((await publicChoice(ids[0]!, true, permissionAt)).error, "registration_conflict");
    await runHistoryMaintenance(admin);
    assert.equal(checkedPublicUsage(await publicUsage()).series[0]!.count, null); // 19 contributors
    assert.equal((await publicChoice(ids[0]!, true, permissionAt + 2)).status, "updated");
    await sql(
      `UPDATE app_tracking.public_permissions_v1 SET eligible_from=${q(month)}; DELETE FROM app_tracking.public_periods_v1;`,
    );
    assert.equal(await finalize(), "finalized");
    let exported = checkedPublicUsage(await publicUsage());
    assert.equal(exported.series[0]!.count, "200");
    const serialized = JSON.stringify(exported);
    for (const field of [
      "monthly_installations",
      "monthly_projects",
      "breakdowns",
      "project_id",
      "installation_id",
      "token_hash",
    ])
      assert.ok(!serialized.includes(field));
    for (const statement of [
      `SELECT app_tracking.admin_history_v1(${q(month)},${q(until)},'ferriki','events','language.use','local')`,
      "SELECT app_tracking.public_usage_v1()",
      `SELECT app_tracking.finalize_history_v1(${q(month)},'ferriki','events','language.use','local')`,
      "SELECT * FROM app_tracking.history_periods_v1",
    ])
      await assert.rejects(psql(runtime, statement));
    await assert.rejects(psql(reporter, "SELECT * FROM app_tracking.history_periods_v1"));
    await assert.rejects(psql(runtime, "SELECT * FROM app_tracking.public_periods_v1"));
    await assert.rejects(psql(reporter, "SELECT * FROM app_tracking.public_permissions_v1"));
    await assert.rejects(psql(reporter, "SELECT app_tracking.maintain_history_v1()"));
    // A late-arrival window cannot be finalized, even with source rows available.
    assert.equal(
      await sql(
        "SELECT app_tracking.finalize_history_v1(date_trunc('month',CURRENT_DATE)::date,'ferriki','events','language.use','local')",
      ),
      "pending",
    );
    // Withdrawing a separate grant invalidates a finalized month immediately.
    const changedAt = permissionAt + 1;
    const setChoice = (enabled: boolean, at: number) =>
      psql(
        runtime,
        `SELECT app_tracking.set_history_permission_v1('ferriki','events',${q(ids[0]!)},${q(token)},${enabled},${at})`,
      ).then(JSON.parse);
    assert.equal((await setChoice(false, changedAt)).status, "updated");
    assert.equal((await history()).months[0]!.data, null);
    assert.equal((await setChoice(true, permissionAt)).error, "registration_conflict");
    assert.equal((await setChoice(true, changedAt)).error, "registration_conflict");
    assert.equal((await setChoice(false, changedAt)).status, "updated");
    assert.equal((await setChoice(false, 0)).error, "registration_conflict");
    assert.equal(
      (await setChoice(true, Date.now() - 91 * 86400000)).error,
      "registration_conflict",
    );
    assert.equal((await setChoice(true, changedAt + 1)).status, "updated");
    // A renewed grant never restores previously eligible dates.
    assert.equal(
      await sql(
        `SELECT eligible_from=CURRENT_DATE+1 FROM app_tracking.history_permissions_v1 WHERE installation_id=${q(ids[0]!)}`,
      ),
      "t",
    );
    await sql(
      `UPDATE app_tracking.history_permissions_v1 SET eligible_from=${q(month)} WHERE installation_id=${q(ids[0]!)}`,
    );
    assert.equal(await finalize(), "finalized");
    await psql(
      runtime,
      `SELECT app_tracking.delete_events_v1('ferriki',${q(ids[0]!)},${q(token)})`,
    );
    value = await history();
    assert.equal(value.months[0]!.state, "incomplete");
    assert.equal(value.months[0]!.reason, "deletion");
    assert.equal(value.months[0]!.data, null);
    exported = checkedPublicUsage(await publicUsage());
    assert.equal(exported.series[0]!.count, null);
    assert.equal(await finalize(), "suppressed"); // 19 remaining contributors fail the cohort rule.
    assert.equal((await history()).months[0]!.data, null);
    // Source-expired deletion removes the whole saved period; no contribution map is kept.
    await sql(`INSERT INTO app_tracking.history_periods_v1(month,tool_id,stream,metric,mode,state,reason,data,expires_at)
      VALUES(${q(oldMonth)},'ferriki','events','language.use','local','finalized','ready',${q(JSON.stringify(candidate.data))}::jsonb,${q(oldMonth)}::date+interval '25 months');`);
    await psql(
      runtime,
      `SELECT app_tracking.delete_events_v1('ferriki',${q(ids[1]!)},${q(token)})`,
    );
    assert.equal(
      await sql(`SELECT state FROM app_tracking.history_periods_v1 WHERE month=${q(oldMonth)}`),
      "incomplete",
    );
    assert.equal(
      await sql(
        `SELECT data IS NULL FROM app_tracking.history_periods_v1 WHERE month=${q(oldMonth)}`,
      ),
      "t",
    );
    assert.equal(
      await sql(
        `SELECT app_tracking.finalize_history_v1(${q(oldMonth)},'ferriki','events','language.use','local')`,
      ),
      "incomplete",
    );
    assert.equal(
      await sql(`SELECT reason FROM app_tracking.history_periods_v1 WHERE month=${q(oldMonth)}`),
      "coverage_gap",
    );
    // A missed scheduler inside declared coverage is explicitly incomplete, never a zero.
    await sql(
      `UPDATE app_tracking.history_policy_v1 SET coverage_from=${q(oldMonth)} WHERE singleton`,
    );
    await sql(
      `SELECT app_tracking.finalize_history_v1(${q(oldMonth)},'ferriki','events','language.use','ci')`,
    );
    assert.equal(
      await sql(
        `SELECT reason FROM app_tracking.history_periods_v1 WHERE month=${q(oldMonth)} AND mode='ci'`,
      ),
      "source_expired",
    );
    // Expiry is read-time visible before physical cleanup.
    await sql(
      "UPDATE app_tracking.history_periods_v1 SET expires_at=statement_timestamp()-interval '1 second'; UPDATE app_tracking.public_periods_v1 SET expires_at=statement_timestamp()-interval '1 second'",
    );
    assert.equal(checkedPublicUsage(await publicUsage()).series.length, 0);
    await runHistoryMaintenance(admin, 300);
    await sql("SELECT app_tracking.invalidate_history_recovery_v1()");
    assert.equal(
      await sql("SELECT enabled FROM app_tracking.history_policy_v1 WHERE singleton"),
      "f",
    );
    assert.equal(
      await sql("SELECT count(*) FROM app_tracking.history_periods_v1 WHERE data IS NOT NULL"),
      "0",
    );
    return {
      monthly_summaries: true,
      cohort_suppression: true,
      dominance: true,
      complementary_suppression: true,
      idempotency: true,
      deletion: true,
      source_expiry: true,
      retention_months: 24,
      public_gate: true,
      scoped_access: true,
    };
  } finally {
    await sql(
      "UPDATE app_tracking.history_policy_v1 SET enabled=false,public_enabled=false,coverage_from=NULL,review_reference=NULL,public_coverage_from=NULL WHERE singleton; DELETE FROM app_tracking.history_periods_v1; DELETE FROM app_tracking.public_periods_v1;",
    );
    await sql(
      `DELETE FROM app_tracking.event_batches_v1 WHERE installation_id IN (${ids.map(q).join(",")}); DELETE FROM app_tracking.event_installations_v1 WHERE installation_id IN (${ids.map(q).join(",")});`,
    );
  }
}
