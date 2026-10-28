-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Publication has a third independent permission. Old history grants never qualify.
ALTER TABLE app_tracking.history_policy_v1 ADD COLUMN public_coverage_from date;
CREATE TABLE app_tracking.public_permissions_v1 (LIKE app_tracking.history_permissions_v1 INCLUDING ALL);
ALTER TABLE app_tracking.public_permissions_v1 ADD FOREIGN KEY(tool_id,stream,installation_id)
 REFERENCES app_tracking.history_permissions_v1(tool_id,stream,installation_id) ON DELETE CASCADE;
CREATE TABLE app_tracking.public_periods_v1 (LIKE app_tracking.history_periods_v1 INCLUDING ALL);

CREATE FUNCTION app_tracking.public_candidate_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
WITH visible AS MATERIALIZED (
  SELECT u.installation_id::text AS identity,u.project_id_version,u.project_id,u.tool_version,u.command,
    NULL::jsonb AS dimensions,u.count::bigint AS count
  FROM app_tracking.reporting_usage_v1 u
  JOIN app_tracking.public_permissions_v1 p ON p.tool_id=u.tool_id AND p.stream='legacy'
    AND p.installation_id=u.installation_id::text AND p.enabled
  WHERE EXISTS(SELECT FROM app_tracking.history_permissions_v1 h WHERE h.tool_id=p.tool_id AND h.stream=p.stream AND h.installation_id=p.installation_id AND h.enabled AND u.day>=h.eligible_from) AND u.day>=p.eligible_from AND p_stream='legacy' AND p_metric='cli.invocation' AND u.tool_id=p_tool AND u.mode=p_mode
    AND u.day>=p_month AND u.day<(p_month+interval '1 month')::date
  UNION ALL
  SELECT e.installation_id,e.project_id_version,e.project_id,e.tool_version,e.dimensions->>'command',e.dimensions,e.count::bigint
  FROM app_tracking.reporting_events_v1 e
  JOIN app_tracking.public_permissions_v1 p ON p.tool_id=e.tool_id AND p.stream='events'
    AND p.installation_id=e.installation_id AND p.enabled
  WHERE EXISTS(SELECT FROM app_tracking.history_permissions_v1 h WHERE h.tool_id=p.tool_id AND h.stream=p.stream AND h.installation_id=p.installation_id AND h.enabled AND e.day>=h.eligible_from-date '1970-01-01') AND e.day>=p.eligible_from-date '1970-01-01' AND p_stream='events' AND e.collection='opt_in' AND e.tool_id=p_tool AND e.mode=p_mode AND e.metric=p_metric
    AND e.day>=p_month-date '1970-01-01' AND e.day<(p_month+interval '1 month')::date-date '1970-01-01'
), expanded AS MATERIALIZED (
  SELECT v.*,d.dimension,d.value FROM visible v
  CROSS JOIN LATERAL (VALUES ('total','all'),
    ('version_family',split_part(v.tool_version,'.',1)||'.'||split_part(v.tool_version,'.',2)),
    ('command',v.command),('kind',v.dimensions->>'kind'),
    ('language',v.dimensions->>'language'),('source',v.dimensions->>'source')) d(dimension,value)
  WHERE d.value IS NOT NULL
), cohort AS (
  SELECT dimension,value,sum(count) AS count,count(DISTINCT identity) AS installations,
    count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL) AS projects
  FROM expanded GROUP BY dimension,value
), installation_contributions AS (
  SELECT dimension,value,identity,sum(count) AS count FROM expanded GROUP BY dimension,value,identity
), project_contributions AS (
  -- All unknown projects count as one possible contributor for screening.
  SELECT dimension,value,project_id_version,project_id,sum(count) AS count FROM expanded
  GROUP BY dimension,value,project_id_version,project_id
), screened AS (
  SELECT c.*,c.installations>=20 AND c.projects>=20
    AND (SELECT max(i.count)*10<=c.count FROM installation_contributions i WHERE i.dimension=c.dimension AND i.value=c.value)
    AND (SELECT max(p.count)*10<=c.count FROM project_contributions p WHERE p.dimension=c.dimension AND p.value=c.value) AS safe
  FROM cohort c
), accepted_dimensions AS (
  SELECT dimension FROM screened GROUP BY dimension HAVING bool_and(safe) AND count(*)<=100
), total AS (SELECT * FROM screened WHERE dimension='total'), cells AS (
  SELECT s.dimension,s.value,s.count::text AS count,s.installations::text AS monthly_installations,s.projects::text AS monthly_projects
  FROM screened s JOIN accepted_dimensions a USING(dimension) WHERE s.dimension<>'total'
)
SELECT CASE WHEN coalesce((SELECT safe FROM total),false) THEN jsonb_build_object(
  'state','finalized','reason','ready','data',jsonb_build_object(
    'count',(SELECT count::text FROM total),
    'monthly_installations',(SELECT installations::text FROM total),
    'monthly_projects',(SELECT projects::text FROM total),
    'breakdowns',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY dimension,value) FROM cells c),'[]'::jsonb),
    'suppressed_breakdowns',coalesce((SELECT jsonb_agg(dimension ORDER BY dimension) FROM
      (SELECT DISTINCT dimension FROM screened WHERE dimension<>'total'
       EXCEPT SELECT dimension FROM accepted_dimensions) rejected),'[]'::jsonb)))
  ELSE jsonb_build_object('state','suppressed','reason','cohort','data',NULL) END
$$;

CREATE FUNCTION app_tracking.finalize_public_history_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; existing app_tracking.public_periods_v1%ROWTYPE;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; candidate jsonb;
BEGIN
  IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_tool IS NULL OR p_tool NOT IN ('dalo','palamedes','ferriki')
    OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool='ferriki' OR p_metric<>'cli.invocation'))
    OR (p_stream='events' AND ((p_tool='ferriki')=(p_metric='cli.invocation'))) THEN RAISE EXCEPTION 'invalid_history_scope'; END IF;
  PERFORM pg_advisory_xact_lock(741391606);
  SELECT * INTO STRICT policy FROM app_tracking.history_policy_v1 WHERE singleton;
  IF NOT policy.enabled OR NOT policy.public_enabled THEN RETURN 'disabled'; END IF;
  IF p_month+interval '25 months'<=statement_timestamp() THEN RETURN 'expired'; END IF;
  IF p_month+interval '1 month 7 days'>today THEN RETURN 'pending'; END IF;
  SELECT * INTO existing FROM app_tracking.public_periods_v1
    WHERE month=p_month AND tool_id=p_tool AND stream=p_stream AND metric=p_metric AND mode=p_mode FOR UPDATE;
  IF FOUND AND existing.state IN ('finalized','suppressed') THEN RETURN existing.state; END IF;
  IF p_month<greatest(policy.coverage_from,policy.public_coverage_from) THEN
    candidate:=jsonb_build_object('state','incomplete','reason','coverage_gap','data',NULL);
  ELSIF p_month<today-89 THEN
    candidate:=jsonb_build_object('state','incomplete','reason','source_expired','data',NULL);
  ELSE candidate:=app_tracking.public_candidate_v1(p_month,p_tool,p_stream,p_metric,p_mode); END IF;
  INSERT INTO app_tracking.public_periods_v1(month,tool_id,stream,metric,mode,state,reason,data,expires_at)
    VALUES(p_month,p_tool,p_stream,p_metric,p_mode,candidate->>'state',candidate->>'reason',CASE WHEN candidate->>'state'='finalized' THEN jsonb_build_object('count',(floor((candidate->'data'->>'count')::numeric/10)*10)::text) ELSE NULL END,p_month+interval '25 months')
    ON CONFLICT(month,tool_id,stream,metric,mode) DO UPDATE
      SET state=excluded.state,reason=excluded.reason,data=excluded.data,finalized_at=statement_timestamp();
  RETURN candidate->>'state';
END $$;

-- Preserve the committed private finalizer and invoke both under the same transaction.
ALTER FUNCTION app_tracking.finalize_history_v1(date,text,text,text,text) RENAME TO finalize_private_history_v1;
CREATE FUNCTION app_tracking.finalize_history_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
 result:=app_tracking.finalize_private_history_v1(p_month,p_tool,p_stream,p_metric,p_mode);
 PERFORM app_tracking.finalize_public_history_v1(p_month,p_tool,p_stream,p_metric,p_mode);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_tracking.invalidate_history_v1(p_tool text,p_stream text,p_from date,p_until date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(741391606);
 UPDATE app_tracking.history_periods_v1 SET state='incomplete',reason='deletion',data=NULL,finalized_at=statement_timestamp()
 WHERE tool_id=p_tool AND stream=p_stream AND month>=date_trunc('month',p_from)::date AND month<=date_trunc('month',p_until)::date;
 UPDATE app_tracking.public_periods_v1 SET state='incomplete',reason='deletion',data=NULL,finalized_at=statement_timestamp()
 WHERE tool_id=p_tool AND stream=p_stream AND month>=date_trunc('month',p_from)::date AND month<=date_trunc('month',p_until)::date;
END $$;

CREATE FUNCTION app_tracking.history_public_withdrawal_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.enabled AND NOT NEW.enabled THEN
   UPDATE app_tracking.public_permissions_v1 SET enabled=false
   WHERE tool_id=OLD.tool_id AND stream=OLD.stream AND installation_id=OLD.installation_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER history_public_withdrawal AFTER UPDATE OF enabled ON app_tracking.history_permissions_v1
FOR EACH ROW EXECUTE FUNCTION app_tracking.history_public_withdrawal_v1();

CREATE FUNCTION app_tracking.set_public_permission_v1(p_tool text,p_stream text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE previous app_tracking.public_permissions_v1%ROWTYPE; identity_active boolean;
  now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_tool IS NULL OR p_tool NOT IN ('dalo','palamedes','ferriki') OR p_stream IS NULL OR p_stream NOT IN ('legacy','events')
    OR p_id IS NULL OR p_token_hash IS NULL OR p_enabled IS NULL OR p_changed_at IS NULL
    OR p_changed_at<0 OR p_changed_at>now_ms+300000 THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF p_stream='events' THEN
    SELECT active AND last_activity_at>clock_timestamp()-interval '90 days' INTO identity_active
      FROM app_tracking.event_installations_v1 WHERE tool_id=p_tool AND installation_id=p_id AND token_hash=p_token_hash FOR UPDATE;
  ELSE
    SELECT state='active' AND last_activity_at>clock_timestamp()-interval '90 days' INTO identity_active
      FROM app_tracking.reporting_installations WHERE tool_id=p_tool AND installation_id::text=p_id AND token_hash=p_token_hash FOR UPDATE;
  END IF;
  IF identity_active IS NULL THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  IF p_enabled AND NOT EXISTS(SELECT FROM app_tracking.history_policy_v1 WHERE singleton AND enabled AND public_enabled) THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF NOT identity_active THEN RETURN jsonb_build_object('error','installation_revoked'); END IF;
  IF p_enabled AND NOT EXISTS(SELECT FROM app_tracking.history_permissions_v1 WHERE tool_id=p_tool AND stream=p_stream AND installation_id=p_id AND enabled) THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF NOT p_enabled AND NOT EXISTS(SELECT FROM app_tracking.history_permissions_v1 WHERE tool_id=p_tool AND stream=p_stream AND installation_id=p_id) THEN RETURN jsonb_build_object('status','updated','changed_at',p_changed_at,'enabled',false); END IF;
  PERFORM pg_advisory_xact_lock(741391606);
  SELECT * INTO previous FROM app_tracking.public_permissions_v1 WHERE tool_id=p_tool AND stream=p_stream AND installation_id=p_id FOR UPDATE;
  IF FOUND AND (previous.changed_at>p_changed_at OR (previous.changed_at=p_changed_at AND previous.enabled<>p_enabled)) THEN
    RETURN jsonb_build_object('error','registration_conflict'); END IF;
  IF p_enabled AND p_changed_at<now_ms-7776000000
    AND NOT coalesce(previous.enabled AND previous.changed_at=p_changed_at,false) THEN
    RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF previous.enabled AND NOT p_enabled THEN
    UPDATE app_tracking.public_periods_v1 SET state='incomplete',reason='deletion',data=NULL,finalized_at=statement_timestamp() WHERE tool_id=p_tool AND stream=p_stream AND month>=date_trunc('month',previous.eligible_from)::date AND month<=date_trunc('month',CURRENT_DATE)::date;
  END IF;
  -- Eligibility starts after server acknowledgement, never at a client-backdated choice.
  INSERT INTO app_tracking.public_permissions_v1 VALUES(p_tool,p_stream,p_id,p_enabled,p_changed_at,CURRENT_DATE+1)
    ON CONFLICT(tool_id,stream,installation_id) DO UPDATE SET enabled=excluded.enabled,changed_at=excluded.changed_at,
      eligible_from=CASE WHEN app_tracking.public_permissions_v1.enabled AND excluded.enabled
        THEN app_tracking.public_permissions_v1.eligible_from ELSE excluded.eligible_from END;
  RETURN jsonb_build_object('status','updated','changed_at',p_changed_at,'enabled',p_enabled);
END $$;

CREATE OR REPLACE FUNCTION app_tracking.public_usage_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(SELECT FROM app_tracking.history_policy_v1 WHERE singleton AND enabled AND public_enabled) THEN
    RETURN jsonb_build_object('error','not_found'); END IF;
  SELECT jsonb_build_object('schema_version',1,'unit','reported_observations','window','complete_utc_months',
    'count_rounding',10,'snapshot_at',statement_timestamp(),
    'series',coalesce((SELECT jsonb_agg(jsonb_build_object('month',month,'tool_id',tool_id,'stream',stream,'metric',metric,'mode',mode,
      'state',CASE WHEN state='finalized' THEN 'available' ELSE 'unavailable' END,
      'count',CASE WHEN state='finalized' THEN (floor((data->>'count')::numeric/10)*10)::text ELSE NULL END)
      ORDER BY month,tool_id,stream,metric,mode)
      FROM app_tracking.public_periods_v1 WHERE expires_at>statement_timestamp()
        AND month>=(SELECT greatest(coverage_from,public_coverage_from) FROM app_tracking.history_policy_v1 WHERE singleton)), '[]'::jsonb)) INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_tracking.invalidate_history_recovery_v1()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(741391606);
 UPDATE app_tracking.history_policy_v1 SET enabled=false,public_enabled=false,coverage_from=NULL,public_coverage_from=NULL;
 UPDATE app_tracking.history_periods_v1 SET state='incomplete',reason='recovery',data=NULL,finalized_at=statement_timestamp();
 UPDATE app_tracking.public_periods_v1 SET state='incomplete',reason='recovery',data=NULL,finalized_at=statement_timestamp();
END $$;

-- Existing bounded maintenance owns both tables' age cleanup.
ALTER FUNCTION app_tracking.maintain_history_v1() RENAME TO maintain_private_history_v1;
CREATE FUNCTION app_tracking.maintain_history_v1()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE item record;
BEGIN
 DELETE FROM app_tracking.public_periods_v1 WHERE expires_at<=statement_timestamp();
 IF EXISTS(SELECT FROM app_tracking.history_policy_v1 WHERE singleton AND enabled AND public_enabled) THEN
  SELECT h.* INTO item FROM app_tracking.history_periods_v1 h
  LEFT JOIN app_tracking.public_periods_v1 p USING(month,tool_id,stream,metric,mode)
  WHERE h.month>=(SELECT greatest(coverage_from,public_coverage_from) FROM app_tracking.history_policy_v1 WHERE singleton)
   AND h.month>=CURRENT_DATE-89 AND h.month+interval '1 month 7 days'<=CURRENT_DATE
   AND (p.month IS NULL OR (p.state='incomplete' AND p.reason='deletion'))
  ORDER BY h.month,h.tool_id,h.stream,h.metric,h.mode LIMIT 1;
  IF FOUND THEN
   PERFORM app_tracking.finalize_public_history_v1(item.month,item.tool_id,item.stream,item.metric,item.mode);
   RETURN true;
  END IF;
 END IF;
 RETURN app_tracking.maintain_private_history_v1();
END $$;
REVOKE ALL ON TABLE app_tracking.public_permissions_v1,app_tracking.public_periods_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tracking.public_candidate_v1(date,text,text,text,text),
 app_tracking.finalize_public_history_v1(date,text,text,text,text),app_tracking.finalize_history_v1(date,text,text,text,text),
 app_tracking.history_public_withdrawal_v1(),app_tracking.set_public_permission_v1(text,text,text,text,boolean,bigint),
 app_tracking.maintain_history_v1() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_tracking.configure_history_v1(p_enabled boolean,p_public boolean,p_review text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF p_enabled IS NULL OR p_public IS NULL OR (p_public AND NOT p_enabled)
    OR (p_enabled AND (p_review IS NULL OR length(p_review) NOT BETWEEN 1 AND 256 OR p_review ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid_history_configuration';
  END IF;
  PERFORM pg_advisory_xact_lock(741391606);
  UPDATE app_tracking.history_policy_v1 SET enabled=p_enabled,public_enabled=p_public,review_reference=p_review,
    -- Never claim complete coverage for a month that began before activation.
    public_coverage_from=CASE WHEN p_public AND NOT public_enabled THEN (date_trunc('month',statement_timestamp())+interval '1 month')::date ELSE public_coverage_from END,
    coverage_from=CASE WHEN p_enabled AND NOT enabled
      THEN (date_trunc('month',statement_timestamp())+interval '1 month')::date ELSE coverage_from END;
END $$;
