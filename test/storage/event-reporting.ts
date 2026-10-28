import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { psql, quote as q } from "../../scripts/storage/psql.ts";
import { hash } from "./fixture.ts";
import { checkedEvents, type EventQuery } from "../../src/reporting/events.ts";

export async function eventReportingIntegration(admin: string, runtime: string, reporter: string) {
  const id = () => randomBytes(32).toString("hex");
  const ids = [id(), id(), id(), id()];
  const token = hash(id()),
    shared = hash(id()),
    fork = hash(id());
  const sql = (source: string) => psql(admin, source);
  const query = async (
    metric = "language.use",
    mode = "local",
    from = "CURRENT_DATE-8",
    until = "CURRENT_DATE+1",
  ) => {
    const source = JSON.parse(
      await psql(
        reporter,
        `SELECT app_tracking.admin_events_v1(${from},${until},'all',${q(mode)},${q(metric)})`,
      ),
    );
    if (source.error) return source;
    const scope: EventQuery = {
      from: source.period.from,
      until: source.period.until,
      tool: "all",
      mode: mode as "local",
      metric: metric as EventQuery["metric"],
    };
    return checkedEvents(source, scope);
  };
  try {
    for (let i = 0; i < ids.length; i++) {
      const tool = i === 2 ? "palamedes" : "ferriki",
        mode = i === 3 ? "ci" : "local";
      await sql(
        `INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode) VALUES (${q(tool)},${q(ids[i]!)},${q(token)},1,${q(mode)})`,
      );
      const batch = id();
      await sql(
        `INSERT INTO app_tracking.event_batches_v1(tool_id,batch_id,content_hash,collection,installation_id,mode) VALUES (${q(tool)},${q(batch)},${q(hash(batch))},'opt_in',${q(ids[i]!)},${q(mode)})`,
      );
      const rows: [number, number, string | null, string, string][] =
        i === 0
          ? [
              [8, 3, shared, "language.use", "explicit"],
              [7, 4, shared, "language.use", "explicit"],
              [1, 5, null, "language.use", "explicit"],
              [1, 11, shared, "language.use", "dependency"],
              [1, 7, shared, "resource.download", "grammar"],
              [89, 29, shared, "language.use", "explicit"],
              [90, 31, shared, "language.use", "explicit"],
            ]
          : i === 1
            ? [
                [7, 13, shared, "language.use", "explicit"],
                [0, 19, fork, "language.use", "explicit"],
              ]
            : i === 2
              ? [[1, 23, shared, "cli.invocation", "extract"]]
              : [[1, 17, shared, "language.use", "explicit"]];
      for (const [n, row] of rows.entries()) {
        const [ago, count, project, metric, category] = row;
        const dimensions =
          metric === "language.use"
            ? { language: "rust", source: category }
            : metric === "resource.download"
              ? { kind: category }
              : { command: category };
        const system = {
          os: "linux",
          os_version: "6.12",
          arch: "aarch64",
          cpu_family: "unknown",
          ...(i === 0
            ? {
                linux: {
                  distribution: "ubuntu",
                  distribution_version: "24.04",
                  kernel_version: "6.12",
                },
              }
            : {}),
        };
        await sql(
          `INSERT INTO app_tracking.event_counts_v1 VALUES (${q(tool)},${q(batch)},${n + 1},(CURRENT_DATE-${ago})-date '1970-01-01',${q(metric)},'2.0.0',${q(JSON.stringify(dimensions))}::jsonb,${q(JSON.stringify(system))}::jsonb,${count},${project ? q(project) : "NULL"},${project ? "1" : "NULL"})`,
        );
      }
    }
    let value = await query();
    assert.deepEqual(value.totals, {
      count: "55",
      active_installations: "2",
      active_projects: "2",
      unknown_project_count: "5",
    });
    assert.equal(
      value.dimensions.find((r: { value: string }) => r.value === "dependency").count,
      "11",
    );
    assert.equal(
      value.systems.find(
        (r: { dimension: string; value: string }) =>
          r.dimension === "linux_distribution" && r.value === "unknown",
      ).count,
      "32",
    );
    assert.equal((await query("resource.download")).totals.count, "7");
    assert.equal((await query("cli.invocation")).totals.count, "23");
    assert.equal((await query("language.use", "ci")).totals.count, "17");
    value = await query("language.use", "local", "CURRENT_DATE-90", "CURRENT_DATE-88");
    assert.equal(value.totals.count, "29");
    assert.equal(value.coverage.clipped, true);
    assert.equal(
      (await query("language.use", "local", "CURRENT_DATE-92", "CURRENT_DATE-90")).error,
      "outside_retention",
    );
    assert.equal((await query("unknown")).error, "invalid_request");
    await assert.rejects(
      psql(
        runtime,
        "SELECT app_tracking.admin_events_v1(CURRENT_DATE-8,CURRENT_DATE+1,'all','local','language.use')",
      ),
    );
    for (const table of ["event_counts_v1", "reporting_events_v1", "event_installations_v1"])
      await assert.rejects(psql(reporter, `SELECT * FROM app_tracking.${table} LIMIT 1`));
    const serialized = JSON.stringify(await query());
    for (const secret of [...ids, token, shared, fork]) assert.ok(!serialized.includes(secret));
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET active=false WHERE tool_id='ferriki' AND installation_id=${q(ids[1]!)}`,
    );
    assert.equal((await query()).totals.count, "23"); // Immediate invisibility, before physical cleanup.
    await sql(
      `UPDATE app_tracking.event_installations_v1 SET active=true WHERE tool_id='ferriki' AND installation_id=${q(ids[1]!)}`,
    );
    const response = JSON.parse(
      await psql(
        runtime,
        `SELECT app_tracking.delete_events_v1('ferriki',${q(ids[0]!)},${q(token)})`,
      ),
    );
    assert.equal(response.status, "deleted");
    assert.equal((await query()).totals.count, "32");
    assert.equal((await query("resource.download")).coverage.has_observations, false);
    return {
      metric_boundaries: true,
      period_uniques: true,
      deletion: true,
      scoped_access: true,
      fixture_installations: ids.length,
      public_data: false,
    };
  } finally {
    await sql(
      `DELETE FROM app_tracking.event_batches_v1 WHERE installation_id IN (${ids.map(q).join(",")}); DELETE FROM app_tracking.event_installations_v1 WHERE installation_id IN (${ids.map(q).join(",")});`,
    );
  }
}
