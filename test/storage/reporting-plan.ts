import assert from "node:assert/strict";
import { psql } from "../../scripts/storage/psql.ts";

export async function reportingQueryPlan(admin: string) {
  // Disposable synthetic rows stay inside one rolled-back transaction. No raw
  // plan (which can contain parameters) is exported as evidence.
  const sql = `BEGIN;
    CREATE TEMP TABLE reporting_plan_ids ON COMMIT DROP AS
      SELECT md5('reporting-plan-'||i)::uuid installation_id,
        CASE WHEN i%2=0 THEN 'dalo' ELSE 'palamedes' END tool_id FROM generate_series(1,100) i;
    INSERT INTO app_tracking.reporting_installations(tool_id,installation_id,token_hash,consent_revision,consented_at,mode,last_activity_at)
      SELECT tool_id,installation_id,repeat('c',64),'telemetry-v1',clock_timestamp()-interval '89 days','local',clock_timestamp() FROM reporting_plan_ids;
    INSERT INTO app_tracking.telemetry_batches(tool_id,installation_id,batch_id,content_hash,received_at)
      SELECT tool_id,installation_id,installation_id,repeat('d',64),clock_timestamp() FROM reporting_plan_ids;
    INSERT INTO app_tracking.usage_counts(tool_id,installation_id,batch_id,row_number,day,tool_version,command,count,project_id,project_id_version)
      SELECT tool_id,installation_id,installation_id,n,CURRENT_DATE-(n%90),'2.'||(n%10)||'.0',
        CASE WHEN tool_id='dalo' THEN 'status' ELSE 'extract' END,10000,
        repeat(md5('synthetic-project-'||(n%40)),2),1 FROM reporting_plan_ids CROSS JOIN generate_series(1,100) n;
    ANALYZE app_tracking.usage_counts; ANALYZE app_tracking.reporting_installations;
    EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
      SELECT sum(u.count),count(DISTINCT (u.tool_id,u.installation_id)),count(DISTINCT (u.project_id_version,u.project_id))
      FROM app_tracking.reporting_usage_v1 u WHERE u.tool_id='palamedes' AND u.mode='local'
        AND u.day>=CURRENT_DATE-6 AND u.day<CURRENT_DATE+1;
    EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
      SELECT app_tracking.admin_usage_v1(CURRENT_DATE-89,CURRENT_DATE+1,'all','local');
    CREATE TEMP TABLE event_reporting_plan_ids ON COMMIT DROP AS
      SELECT repeat(md5('event-reporting-plan-'||i),2) installation_id FROM generate_series(1,100) i;
    INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode)
      SELECT 'ferriki',installation_id,repeat('e',64),1,'local' FROM event_reporting_plan_ids;
    INSERT INTO app_tracking.event_batches_v1(tool_id,batch_id,content_hash,collection,installation_id,mode)
      SELECT 'ferriki',installation_id,repeat('f',64),'opt_in',installation_id,'local' FROM event_reporting_plan_ids;
    INSERT INTO app_tracking.event_counts_v1(tool_id,batch_id,row_number,day,metric,tool_version,dimensions,system,count,project_id,project_id_version)
      SELECT 'ferriki',installation_id,n,(CURRENT_DATE-(n%90))-date '1970-01-01','language.use','2.'||(n%10)||'.0',
        jsonb_build_object('language',CASE WHEN n%5=0 THEN 'typescript' ELSE 'rust' END,'source',CASE WHEN n%3=0 THEN 'dependency' ELSE 'explicit' END),
        jsonb_build_object('os','linux','os_version','6.12','arch','aarch64','cpu_family','unknown'),
        10000,repeat(md5('synthetic-project-'||(n%40)),2),1 FROM event_reporting_plan_ids CROSS JOIN generate_series(1,64) n;
    ANALYZE app_tracking.event_counts_v1; ANALYZE app_tracking.event_installations_v1; ANALYZE app_tracking.event_batches_v1;
    EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)
      SELECT app_tracking.admin_events_v1(CURRENT_DATE-89,CURRENT_DATE+1,'all','local','language.use');
    ROLLBACK;`;
  const text = await psql(admin, sql);
  // psql emits two independent JSON arrays, separated by a newline.
  const plans = JSON.parse("[" + text.replace(/\]\s*\[/g, "],[") + "]") as Record<
    string,
    unknown
  >[][];
  assert.equal(plans.length, 3);
  const indexes = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) {
        if (name === "Index Name" && typeof item === "string") indexes.add(item);
        else visit(item);
      }
  }
  visit(plans[0]);
  const narrow = Number(plans[0]![0]!["Execution Time"]),
    full = Number(plans[1]![0]!["Execution Time"]),
    events = Number(plans[2]![0]!["Execution Time"]);
  assert.ok(Number.isFinite(narrow) && Number.isFinite(full) && Number.isFinite(events));
  return {
    engine: "PostgreSQL 18.6",
    synthetic_rows: 10000,
    synthetic_installations: 100,
    narrow_period_days: 7,
    full_period_days: 90,
    narrow_execution_ms: narrow,
    full_execution_ms: full,
    event_synthetic_rows: 6400,
    event_full_execution_ms: events,
    indexes: [...indexes].sort(),
    production_latency_claim: false,
  };
}
