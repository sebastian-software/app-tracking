-- SPDX-License-Identifier: MIT OR Apache-2.0
-- This additive schema does not enable persistence or a public export.
CREATE TABLE app_tracking.history_policy_v1(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  public_enabled boolean NOT NULL DEFAULT false,
  coverage_from date CHECK(coverage_from IS NULL OR coverage_from=date_trunc('month',coverage_from)::date),
  review_reference text,
  CHECK(NOT enabled OR (coverage_from IS NOT NULL AND review_reference IS NOT NULL)),
  CHECK(NOT public_enabled OR enabled)
);
INSERT INTO app_tracking.history_policy_v1(singleton) VALUES(true);
CREATE TABLE app_tracking.history_periods_v1(
  month date NOT NULL CHECK(month=date_trunc('month',month)::date),
  tool_id text NOT NULL CHECK(tool_id IN ('dalo','palamedes','ferriki')),
  stream text NOT NULL CHECK(stream IN ('legacy','events')),
  metric text NOT NULL CHECK(metric IN ('cli.invocation','resource.download','language.use')),
  mode text NOT NULL CHECK(mode IN ('local','ci')),
  state text NOT NULL CHECK(state IN ('pending','finalized','suppressed','incomplete')),
  reason text NOT NULL CHECK(reason IN ('ready','cohort','source_expired','coverage_gap','deletion','recovery')),
  data jsonb,
  finalized_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(month,tool_id,stream,metric,mode),
  CHECK((state='finalized')=(data IS NOT NULL))
);
CREATE INDEX history_periods_expiry ON app_tracking.history_periods_v1(expires_at);

-- Additional permission has the same lifecycle as its reporting identity.
-- It is not a monthly source-to-summary ledger and is never exported.
CREATE TABLE app_tracking.history_permissions_v1(
  tool_id text NOT NULL,
  stream text NOT NULL CHECK(stream IN ('legacy','events')),
  installation_id text NOT NULL,
  enabled boolean NOT NULL,
  changed_at bigint NOT NULL,
  eligible_from date NOT NULL,
  PRIMARY KEY(tool_id,stream,installation_id)
);

-- Source identifiers exist only inside this statement; no contribution ledger,
-- identifier set, or unsafe hidden breakdown survives finalization.
CREATE FUNCTION app_tracking.history_candidate_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
WITH visible AS MATERIALIZED (
  SELECT u.installation_id::text AS identity,u.project_id_version,u.project_id,u.tool_version,u.command,
    NULL::jsonb AS dimensions,u.count::bigint AS count
  FROM app_tracking.reporting_usage_v1 u
  JOIN app_tracking.history_permissions_v1 p ON p.tool_id=u.tool_id AND p.stream='legacy'
    AND p.installation_id=u.installation_id::text AND p.enabled
  WHERE u.day>=p.eligible_from AND p_stream='legacy' AND p_metric='cli.invocation' AND u.tool_id=p_tool AND u.mode=p_mode
    AND u.day>=p_month AND u.day<(p_month+interval '1 month')::date
  UNION ALL
  SELECT e.installation_id,e.project_id_version,e.project_id,e.tool_version,e.dimensions->>'command',e.dimensions,e.count::bigint
  FROM app_tracking.reporting_events_v1 e
  JOIN app_tracking.history_permissions_v1 p ON p.tool_id=e.tool_id AND p.stream='events'
    AND p.installation_id=e.installation_id AND p.enabled
  WHERE e.day>=p.eligible_from-date '1970-01-01' AND p_stream='events' AND e.collection='opt_in' AND e.tool_id=p_tool AND e.mode=p_mode AND e.metric=p_metric
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

CREATE FUNCTION app_tracking.finalize_history_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; existing app_tracking.history_periods_v1%ROWTYPE;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; candidate jsonb;
BEGIN
  IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_tool IS NULL OR p_tool NOT IN ('dalo','palamedes','ferriki')
    OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool='ferriki' OR p_metric<>'cli.invocation'))
    OR (p_stream='events' AND ((p_tool='ferriki')=(p_metric='cli.invocation'))) THEN RAISE EXCEPTION 'invalid_history_scope'; END IF;
  PERFORM pg_advisory_xact_lock(741391606);
  SELECT * INTO STRICT policy FROM app_tracking.history_policy_v1 WHERE singleton;
  IF NOT policy.enabled THEN RETURN 'disabled'; END IF;
  IF p_month+interval '25 months'<=statement_timestamp() THEN RETURN 'expired'; END IF;
  IF p_month+interval '1 month 7 days'>today THEN RETURN 'pending'; END IF;
  SELECT * INTO existing FROM app_tracking.history_periods_v1
    WHERE month=p_month AND tool_id=p_tool AND stream=p_stream AND metric=p_metric AND mode=p_mode FOR UPDATE;
  IF FOUND AND existing.state IN ('finalized','suppressed') THEN RETURN existing.state; END IF;
  IF p_month<policy.coverage_from THEN
    candidate:=jsonb_build_object('state','incomplete','reason','coverage_gap','data',NULL);
  ELSIF p_month<today-89 THEN
    candidate:=jsonb_build_object('state','incomplete','reason','source_expired','data',NULL);
  ELSE candidate:=app_tracking.history_candidate_v1(p_month,p_tool,p_stream,p_metric,p_mode); END IF;
  INSERT INTO app_tracking.history_periods_v1(month,tool_id,stream,metric,mode,state,reason,data,expires_at)
    VALUES(p_month,p_tool,p_stream,p_metric,p_mode,candidate->>'state',candidate->>'reason',nullif(candidate->'data','null'::jsonb),p_month+interval '25 months')
    ON CONFLICT(month,tool_id,stream,metric,mode) DO UPDATE
      SET state=excluded.state,reason=excluded.reason,data=excluded.data,finalized_at=statement_timestamp();
  RETURN candidate->>'state';
END $$;

-- With no long-lived contribution map, deletion invalidates whole affected
-- periods. Recompute only while all source dates remain; otherwise keep a gap.
CREATE FUNCTION app_tracking.invalidate_history_v1(p_tool text,p_stream text,p_from date,p_until date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(741391606);
  UPDATE app_tracking.history_periods_v1 SET state='incomplete',reason='deletion',data=NULL,finalized_at=statement_timestamp()
    WHERE tool_id=p_tool AND stream=p_stream AND month>=date_trunc('month',p_from)::date
      AND month<=date_trunc('month',p_until)::date;
END $$;
CREATE FUNCTION app_tracking.history_identity_removed_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE first_month date;
BEGIN
  IF TG_TABLE_NAME='reporting_installations' THEN
    IF TG_OP='DELETE' OR (OLD.state='active' AND NEW.state<>'active') THEN
      PERFORM app_tracking.invalidate_history_v1(OLD.tool_id,'legacy',(OLD.consented_at-interval '7 days')::date,OLD.last_activity_at::date);
      DELETE FROM app_tracking.history_permissions_v1 WHERE tool_id=OLD.tool_id AND stream='legacy' AND installation_id=OLD.installation_id::text;
    END IF;
  ELSE
    IF TG_OP='DELETE' OR (OLD.active AND NOT NEW.active) THEN
      first_month:=(to_timestamp(OLD.consented_at::double precision/1000)-interval '7 days')::date;
      PERFORM app_tracking.invalidate_history_v1(OLD.tool_id,'events',first_month,OLD.last_activity_at::date);
      DELETE FROM app_tracking.history_permissions_v1 WHERE tool_id=OLD.tool_id AND stream='events' AND installation_id=OLD.installation_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER history_legacy_deletion AFTER DELETE OR UPDATE OF state ON app_tracking.reporting_installations
  FOR EACH ROW EXECUTE FUNCTION app_tracking.history_identity_removed_v1();
CREATE TRIGGER history_event_deletion AFTER DELETE OR UPDATE OF active ON app_tracking.event_installations_v1
  FOR EACH ROW EXECUTE FUNCTION app_tracking.history_identity_removed_v1();

REVOKE ALL ON FUNCTION app_tracking.history_candidate_v1(date,text,text,text,text),
  app_tracking.finalize_history_v1(date,text,text,text,text),app_tracking.invalidate_history_v1(text,text,date,date),
  app_tracking.history_identity_removed_v1() FROM PUBLIC;

CREATE FUNCTION app_tracking.configure_history_v1(p_enabled boolean,p_public boolean,p_review text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF p_enabled IS NULL OR p_public IS NULL OR (p_public AND NOT p_enabled)
    OR (p_enabled AND (p_review IS NULL OR length(p_review) NOT BETWEEN 1 AND 256 OR p_review ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid_history_configuration';
  END IF;
  PERFORM pg_advisory_xact_lock(741391606);
  UPDATE app_tracking.history_policy_v1 SET enabled=p_enabled,public_enabled=p_public,review_reference=p_review,
    -- Never claim complete coverage for a month that began before activation.
    coverage_from=CASE WHEN p_enabled AND NOT enabled
      THEN (date_trunc('month',statement_timestamp())+interval '1 month')::date ELSE coverage_from END;
END $$;

CREATE FUNCTION app_tracking.maintain_history_v1()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; item record;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(741391606);
  DELETE FROM app_tracking.history_periods_v1 WHERE expires_at<=statement_timestamp();
  SELECT * INTO STRICT policy FROM app_tracking.history_policy_v1 WHERE singleton;
  IF NOT policy.enabled THEN RETURN false; END IF;
  SELECT m.month::date,s.tool,s.stream,s.metric,c.mode INTO item
  FROM generate_series(greatest(policy.coverage_from,(date_trunc('month',today)-interval '24 months')::date)::timestamp,
    (date_trunc('month',today)-interval '1 month')::timestamp,interval '1 month') m(month)
  CROSS JOIN (VALUES ('dalo','legacy','cli.invocation'),('palamedes','legacy','cli.invocation'),
    ('dalo','events','cli.invocation'),('palamedes','events','cli.invocation'),
    ('ferriki','events','resource.download'),('ferriki','events','language.use')) s(tool,stream,metric)
  CROSS JOIN (VALUES ('local'),('ci')) c(mode)
  LEFT JOIN app_tracking.history_periods_v1 h ON h.month=m.month AND h.tool_id=s.tool AND h.stream=s.stream AND h.metric=s.metric AND h.mode=c.mode
  WHERE m.month+interval '1 month 7 days'<=today
    AND (h.month IS NULL OR (h.state='incomplete' AND h.reason='deletion' AND h.month>=today-89))
  ORDER BY m.month,s.tool,s.stream,s.metric,c.mode LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM app_tracking.finalize_history_v1(item.month,item.tool,item.stream,item.metric,item.mode);
  RETURN true;
END $$;

CREATE FUNCTION app_tracking.admin_history_v1(p_from date,p_until date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; result jsonb;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_from<>date_trunc('month',p_from)::date OR p_until<>date_trunc('month',p_until)::date
    OR p_until<=p_from OR p_until>date_trunc('month',today)+interval '1 month' OR p_until>p_from+interval '24 months'
    OR p_tool IS NULL OR p_tool NOT IN ('all','dalo','palamedes','ferriki') OR p_stream IS NULL OR p_stream NOT IN ('legacy','events')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool='ferriki' OR p_metric<>'cli.invocation'))
    OR p_mode IS NULL OR p_mode NOT IN ('local','ci') THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  SELECT * INTO STRICT policy FROM app_tracking.history_policy_v1 WHERE singleton;
  SELECT jsonb_build_object('schema_version',1,'enabled',policy.enabled,'retention_months',24,
    'period',jsonb_build_object('from',p_from,'until',p_until,'snapshot_at',statement_timestamp(),'coverage_from',policy.coverage_from),
    'scope',jsonb_build_object('tool',p_tool,'stream',p_stream,'metric',p_metric,'mode',p_mode),
    'months',coalesce((SELECT jsonb_agg(jsonb_build_object('month',m.month::date,'tool_id',t.tool,
      'state',CASE WHEN NOT policy.enabled THEN 'disabled' WHEN m.month+interval '25 months'<=statement_timestamp() THEN 'expired'
        WHEN m.month<policy.coverage_from THEN 'incomplete' WHEN m.month+interval '1 month 7 days'>today THEN 'pending' ELSE coalesce(h.state,'incomplete') END,
      'reason',CASE WHEN NOT policy.enabled THEN 'disabled' WHEN m.month+interval '25 months'<=statement_timestamp() THEN 'expired'
        WHEN m.month<policy.coverage_from THEN 'coverage_gap' WHEN m.month+interval '1 month 7 days'>today THEN 'late_arrival' ELSE coalesce(h.reason,'missing_finalizer') END,
      'data',CASE WHEN policy.enabled AND h.expires_at>statement_timestamp() AND h.state='finalized' AND m.month>=policy.coverage_from THEN h.data ELSE NULL END)
      ORDER BY m.month,t.tool)
      FROM generate_series(p_from::timestamp,(p_until-interval '1 month')::timestamp,interval '1 month') m(month)
      CROSS JOIN (SELECT tool FROM (VALUES ('dalo'),('palamedes'),('ferriki')) tools(tool)
        WHERE (p_tool='all' OR tool=p_tool) AND ((p_stream='legacy' AND tool<>'ferriki') OR
          (p_stream='events' AND ((tool='ferriki')=(p_metric<>'cli.invocation'))))) t
      LEFT JOIN app_tracking.history_periods_v1 h ON h.month=m.month AND h.tool_id=t.tool AND h.stream=p_stream AND h.metric=p_metric AND h.mode=p_mode),'[]'::jsonb)) INTO result;
  RETURN result;
END $$;

-- No arbitrary dates, dimensions, or identifiers cross the public boundary.
-- Only finalized total cells; no command/version/system/project breakdowns.
CREATE FUNCTION app_tracking.public_usage_v1()
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
      FROM app_tracking.history_periods_v1 WHERE expires_at>statement_timestamp()
        AND month>=(SELECT coverage_from FROM app_tracking.history_policy_v1 WHERE singleton)), '[]'::jsonb)) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_tracking.configure_history_v1(boolean,boolean,text),app_tracking.maintain_history_v1(),
  app_tracking.admin_history_v1(date,date,text,text,text,text),app_tracking.public_usage_v1() FROM PUBLIC;

CREATE FUNCTION app_tracking.invalidate_history_recovery_v1()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(741391606);
  UPDATE app_tracking.history_policy_v1 SET enabled=false,public_enabled=false,coverage_from=NULL;
  UPDATE app_tracking.history_periods_v1 SET state='incomplete',reason='recovery',data=NULL,finalized_at=statement_timestamp();
END $$;
REVOKE ALL ON FUNCTION app_tracking.invalidate_history_recovery_v1() FROM PUBLIC;

-- A tool credential can change only its own additional permission. Existing
-- usage grants do not acquire historical retention when a server flag changes.
CREATE FUNCTION app_tracking.set_history_permission_v1(p_tool text,p_stream text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE previous app_tracking.history_permissions_v1%ROWTYPE; identity_active boolean;
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
  IF p_enabled AND NOT EXISTS(SELECT FROM app_tracking.history_policy_v1 WHERE singleton AND enabled) THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF NOT identity_active THEN RETURN jsonb_build_object('error','installation_revoked'); END IF;
  SELECT * INTO previous FROM app_tracking.history_permissions_v1 WHERE tool_id=p_tool AND stream=p_stream AND installation_id=p_id FOR UPDATE;
  IF FOUND AND (previous.changed_at>p_changed_at OR (previous.changed_at=p_changed_at AND previous.enabled<>p_enabled)) THEN
    RETURN jsonb_build_object('error','registration_conflict'); END IF;
  IF p_enabled AND p_changed_at<now_ms-7776000000
    AND NOT coalesce(previous.enabled AND previous.changed_at=p_changed_at,false) THEN
    RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF previous.enabled AND NOT p_enabled THEN
    PERFORM app_tracking.invalidate_history_v1(p_tool,p_stream,previous.eligible_from,CURRENT_DATE);
  END IF;
  -- Eligibility starts after server acknowledgement, never at a client-backdated choice.
  INSERT INTO app_tracking.history_permissions_v1 VALUES(p_tool,p_stream,p_id,p_enabled,p_changed_at,CURRENT_DATE+1)
    ON CONFLICT(tool_id,stream,installation_id) DO UPDATE SET enabled=excluded.enabled,changed_at=excluded.changed_at,
      eligible_from=CASE WHEN app_tracking.history_permissions_v1.enabled AND excluded.enabled
        THEN app_tracking.history_permissions_v1.eligible_from ELSE excluded.eligible_from END;
  RETURN jsonb_build_object('status','updated','changed_at',p_changed_at,'enabled',p_enabled);
END $$;
REVOKE ALL ON FUNCTION app_tracking.set_history_permission_v1(text,text,text,text,boolean,bigint) FROM PUBLIC;
