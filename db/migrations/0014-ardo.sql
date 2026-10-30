-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Register Ardo without changing collection defaults or existing consent grants.
INSERT INTO app_tracking.event_catalog_v1 VALUES ('ardo','{"cli.invocation":{"collection":"opt_in","dimensions":{"command":["dev","build","preview","other"]},"system":"full","project":true}}'::jsonb);

ALTER TABLE app_tracking.history_periods_v1 DROP CONSTRAINT history_periods_v1_tool_id_check;
ALTER TABLE app_tracking.history_periods_v1 ADD CONSTRAINT history_periods_v1_tool_id_check
  CHECK(tool_id IN ('ardo','dalo','palamedes','ferriki'));
-- LIKE INCLUDING ALL retained the original check constraint's name.
ALTER TABLE app_tracking.public_periods_v1 DROP CONSTRAINT history_periods_v1_tool_id_check;
ALTER TABLE app_tracking.public_periods_v1 ADD CONSTRAINT public_periods_v1_tool_id_check
  CHECK(tool_id IN ('ardo','dalo','palamedes','ferriki'));

ALTER TABLE app_tracking.service_requests_v1 DROP CONSTRAINT service_requests_v1_check;
ALTER TABLE app_tracking.service_requests_v1 ADD CONSTRAINT service_requests_v1_check
  CHECK((tool_id='dalo' AND distribution IN ('github','npm','standalone'))
    OR (tool_id IN ('ardo','palamedes') AND distribution IN ('github','npm')));

CREATE OR REPLACE FUNCTION app_tracking.admin_events_v1(p_from date,p_until date,p_tool text,p_mode text,p_metric text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
  first_day date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90
    OR p_until>today+1 OR p_tool IS NULL OR p_tool NOT IN ('all','ardo','dalo','palamedes','ferriki')
    OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use') THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  first_day:=greatest(p_from,today-89);
  IF p_until<=first_day THEN
    RETURN jsonb_build_object('error','outside_retention','retained_from',today-89);
  END IF;
  WITH visible AS MATERIALIZED (
    SELECT e.*,date '1970-01-01'+e.day AS occurrence_day
    FROM app_tracking.reporting_events_v1 e
    WHERE e.day>=first_day-date '1970-01-01' AND e.day<p_until-date '1970-01-01'
      AND e.mode=p_mode AND e.metric=p_metric AND e.collection='opt_in'
      AND (p_tool='all' OR e.tool_id=p_tool)
  ), totals AS (
    SELECT coalesce(sum(count),0)::text count,
      count(DISTINCT (tool_id,installation_id))::text active_installations,
      (count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL))::text active_projects,
      coalesce(sum(count) FILTER(WHERE project_id IS NULL),0)::text unknown_project_count
    FROM visible
  ), by_day AS (
    SELECT occurrence_day,sum(count)::text count,
      count(DISTINCT (tool_id,installation_id))::text active_installations,
      (count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL))::text active_projects
    FROM visible GROUP BY occurrence_day
  ), daily AS (
    SELECT d::date AS day,coalesce(b.count,'0') count,
      coalesce(b.active_installations,'0') active_installations,
      coalesce(b.active_projects,'0') active_projects
    FROM generate_series(first_day::timestamp,(p_until-1)::timestamp,interval '1 day') d
    LEFT JOIN by_day b ON b.occurrence_day=d::date
  ), versions AS (
    SELECT tool_id,tool_version,sum(count) count FROM visible GROUP BY tool_id,tool_version
  ), top_versions AS (
    SELECT tool_id,tool_version,count::text count FROM versions
    ORDER BY versions.count DESC,tool_id,tool_version LIMIT 100
  ), dimensions AS (
    SELECT tool_id,d.key AS dimension,d.value,sum(e.count) count FROM visible e
    CROSS JOIN LATERAL jsonb_each_text(e.dimensions) d
    WHERE d.key IN ('command','kind','language','source')
    GROUP BY tool_id,d.key,d.value
  ), ranked_dimensions AS (
    SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY count DESC,tool_id,value) AS rank FROM dimensions
  ), top_dimensions AS (
    SELECT tool_id,dimension,value,count::text count FROM ranked_dimensions WHERE rank<=100
  ), systems AS (
    SELECT s.dimension,s.value,sum(e.count) count FROM visible e
    CROSS JOIN LATERAL (VALUES
      ('os',coalesce(e.system->>'os','unknown')),
      ('os_version',coalesce(e.system->>'os_version','unknown')),
      ('arch',coalesce(e.system->>'arch','unknown')),
      ('cpu_family',coalesce(e.system->>'cpu_family','unknown')),
      ('linux_distribution',coalesce(e.system->'linux'->>'distribution','unknown')),
      ('linux_distribution_version',coalesce(e.system->'linux'->>'distribution_version','unknown')),
      ('linux_kernel_version',coalesce(e.system->'linux'->>'kernel_version','unknown'))
    ) s(dimension,value)
    -- Linux-only fields have an explicit missing category within Linux, not all OSes.
    WHERE s.dimension NOT LIKE 'linux_%' OR e.system->>'os'='linux'
    GROUP BY s.dimension,s.value
  ), ranked_systems AS (
    SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY count DESC,value) AS rank FROM systems
  ), top_systems AS (
    SELECT dimension,value,count::text count FROM ranked_systems WHERE rank<=100
  ) SELECT jsonb_build_object(
    'schema_version',1,'period',jsonb_build_object('from',p_from,'until',p_until,
      'covered_from',first_day,'snapshot_at',statement_timestamp()),
    'scope',jsonb_build_object('tool',p_tool,'mode',p_mode,'metric',p_metric),
    'coverage',jsonb_build_object('retained_from',today-89,'clipped',first_day<>p_from,
      'provisional_from',today-6,'has_observations',EXISTS(SELECT FROM visible),
      'versions_truncated',(SELECT count(*)>100 FROM versions),
      'dimensions_truncated',EXISTS(SELECT FROM ranked_dimensions WHERE rank>100),
      'systems_truncated',EXISTS(SELECT FROM ranked_systems WHERE rank>100)),
    'totals',(SELECT to_jsonb(t) FROM totals t),
    'daily',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY day) FROM daily d),'[]'::jsonb),
    'versions',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY count::numeric DESC,tool_id,tool_version) FROM top_versions v),'[]'::jsonb),
    'dimensions',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY dimension,count::numeric DESC,tool_id,value) FROM top_dimensions d),'[]'::jsonb),
    'systems',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY dimension,count::numeric DESC,value) FROM top_systems s),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_tracking.finalize_private_history_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; existing app_tracking.history_periods_v1%ROWTYPE;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; candidate jsonb;
BEGIN
  IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_tool IS NULL OR p_tool NOT IN ('ardo','dalo','palamedes','ferriki')
    OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool IN ('ardo','ferriki') OR p_metric<>'cli.invocation'))
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

CREATE OR REPLACE FUNCTION app_tracking.maintain_private_history_v1()
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
    ('ardo','events','cli.invocation'),('dalo','events','cli.invocation'),('palamedes','events','cli.invocation'),
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

CREATE OR REPLACE FUNCTION app_tracking.admin_history_v1(p_from date,p_until date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; result jsonb;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_from<>date_trunc('month',p_from)::date OR p_until<>date_trunc('month',p_until)::date
    OR p_until<=p_from OR p_until>date_trunc('month',today)+interval '1 month' OR p_until>p_from+interval '24 months'
    OR p_tool IS NULL OR p_tool NOT IN ('all','ardo','dalo','palamedes','ferriki') OR p_stream IS NULL OR p_stream NOT IN ('legacy','events')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool IN ('ardo','ferriki') OR p_metric<>'cli.invocation'))
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
      CROSS JOIN (SELECT tool FROM (VALUES ('ardo'),('dalo'),('palamedes'),('ferriki')) tools(tool)
        WHERE (p_tool='all' OR tool=p_tool) AND ((p_stream='legacy' AND tool NOT IN ('ardo','ferriki')) OR
          (p_stream='events' AND ((tool='ferriki')=(p_metric<>'cli.invocation'))))) t
      LEFT JOIN app_tracking.history_periods_v1 h ON h.month=m.month AND h.tool_id=t.tool AND h.stream=p_stream AND h.metric=p_metric AND h.mode=p_mode),'[]'::jsonb)) INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_tracking.set_history_permission_v1(p_tool text,p_stream text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE previous app_tracking.history_permissions_v1%ROWTYPE; identity_active boolean;
  now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_tool IS NULL OR p_tool NOT IN ('ardo','dalo','palamedes','ferriki') OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR (p_tool='ardo' AND p_stream='legacy')
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

CREATE OR REPLACE FUNCTION app_tracking.set_profile_link_v1(p_tool text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint,p_profile text,p_profile_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE identity app_tracking.event_installations_v1%ROWTYPE; previous app_tracking.profile_links_v1%ROWTYPE;
  profile app_tracking.shared_profiles_v1%ROWTYPE; had_previous boolean;
  now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_tool IS NULL OR p_tool NOT IN ('ardo','dalo','palamedes','ferriki') OR p_id IS NULL OR p_id !~ '^[0-9a-f]{64}$'
    OR p_token_hash IS NULL OR p_enabled IS NULL OR p_changed_at IS NULL OR p_changed_at<0 OR p_changed_at>now_ms+300000
    OR (p_enabled AND (p_profile IS NULL OR p_profile !~ '^[0-9a-f]{64}$' OR p_profile_token_hash IS NULL OR p_profile_token_hash !~ '^[0-9a-f]{64}$'))
    OR (NOT p_enabled AND (p_profile IS NOT NULL OR p_profile_token_hash IS NOT NULL)) THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  SELECT * INTO identity FROM app_tracking.event_installations_v1 WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  IF NOT FOUND OR identity.token_hash<>p_token_hash THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  IF NOT identity.active OR identity.last_activity_at<=clock_timestamp()-interval '90 days' THEN RETURN jsonb_build_object('error','installation_revoked'); END IF;
  IF identity.mode<>'local' THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(741391607);
  IF p_enabled AND NOT EXISTS(SELECT FROM app_tracking.profile_policy_v1 WHERE singleton AND enabled) THEN RETURN jsonb_build_object('error','not_found'); END IF;
  SELECT * INTO previous FROM app_tracking.profile_links_v1 WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  had_previous:=FOUND;
  IF had_previous AND (previous.changed_at>p_changed_at OR (previous.changed_at=p_changed_at AND
    (previous.enabled<>p_enabled OR previous.profile_id IS DISTINCT FROM p_profile))) THEN RETURN jsonb_build_object('error','registration_conflict'); END IF;
  IF p_enabled AND p_changed_at<now_ms-7776000000 AND NOT coalesce(previous.enabled AND previous.changed_at=p_changed_at,false) THEN
    RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF p_enabled THEN
    IF previous.profile_id IS DISTINCT FROM p_profile AND (SELECT count(*) FROM app_tracking.profile_links_v1 WHERE profile_id=p_profile AND enabled)>=32 THEN
      RETURN jsonb_build_object('error','count_limit'); END IF;
    SELECT * INTO profile FROM app_tracking.shared_profiles_v1 WHERE profile_id=p_profile FOR UPDATE;
    IF FOUND THEN
      IF profile.token_hash<>p_profile_token_hash THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
      IF NOT profile.active OR (profile.changed_at<=clock_timestamp()-interval '90 days' AND NOT EXISTS(
        SELECT FROM app_tracking.profile_links_v1 l JOIN app_tracking.event_installations_v1 i USING(tool_id,installation_id)
        WHERE l.profile_id=p_profile AND l.enabled AND i.active AND i.last_activity_at>clock_timestamp()-interval '90 days')) THEN
        RETURN jsonb_build_object('error','installation_revoked'); END IF;
    ELSE
      INSERT INTO app_tracking.shared_profiles_v1(profile_id,token_hash) VALUES(p_profile,p_profile_token_hash);
    END IF;
    UPDATE app_tracking.shared_profiles_v1 SET changed_at=clock_timestamp() WHERE profile_id=p_profile;
  END IF;
  IF previous.profile_id IS NOT NULL AND previous.profile_id IS DISTINCT FROM p_profile THEN
    UPDATE app_tracking.shared_profiles_v1 SET changed_at=clock_timestamp() WHERE profile_id=previous.profile_id;
  END IF;
  INSERT INTO app_tracking.profile_links_v1 VALUES(p_tool,p_id,p_enabled,p_changed_at,p_profile,CURRENT_DATE+1)
    ON CONFLICT(tool_id,installation_id) DO UPDATE SET enabled=excluded.enabled,changed_at=excluded.changed_at,profile_id=excluded.profile_id,
      eligible_from=CASE WHEN app_tracking.profile_links_v1.enabled AND excluded.enabled AND app_tracking.profile_links_v1.profile_id=excluded.profile_id
        THEN app_tracking.profile_links_v1.eligible_from ELSE excluded.eligible_from END;
  RETURN jsonb_build_object('status','updated','enabled',p_enabled,'changed_at',p_changed_at,'profile_id',p_profile);
END $$;

CREATE OR REPLACE FUNCTION app_tracking.finalize_public_history_v1(p_month date,p_tool text,p_stream text,p_metric text,p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE policy app_tracking.history_policy_v1%ROWTYPE; existing app_tracking.public_periods_v1%ROWTYPE;
  today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; candidate jsonb;
BEGIN
  IF p_month IS NULL OR p_month<>date_trunc('month',p_month)::date OR p_tool IS NULL OR p_tool NOT IN ('ardo','dalo','palamedes','ferriki')
    OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_metric IS NULL OR p_metric NOT IN ('cli.invocation','resource.download','language.use')
    OR (p_stream='legacy' AND (p_tool IN ('ardo','ferriki') OR p_metric<>'cli.invocation'))
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

CREATE OR REPLACE FUNCTION app_tracking.set_public_permission_v1(p_tool text,p_stream text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE previous app_tracking.public_permissions_v1%ROWTYPE; identity_active boolean;
  now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_tool IS NULL OR p_tool NOT IN ('ardo','dalo','palamedes','ferriki') OR p_stream IS NULL OR p_stream NOT IN ('legacy','events') OR (p_tool='ardo' AND p_stream='legacy')
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

CREATE OR REPLACE FUNCTION app_tracking.count_version_request_v1(p_tool text,p_distribution text,p_channel text,p_status integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF p_tool IS NULL OR p_distribution IS NULL OR p_channel IS DISTINCT FROM 'stable'
    OR p_status IS NULL OR p_status NOT IN (200,304,503)
    OR NOT ((p_tool='dalo' AND p_distribution IN ('github','npm','standalone'))
      OR (p_tool IN ('ardo','palamedes') AND p_distribution IN ('github','npm'))) THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  INSERT INTO app_tracking.service_requests_v1 AS c VALUES
    ((statement_timestamp() AT TIME ZONE 'UTC')::date,p_tool,p_distribution,p_channel,p_status,1)
  ON CONFLICT(day,tool_id,distribution,channel,status)
    DO UPDATE SET count=least(c.count+1,1000000000000);
  RETURN jsonb_build_object('status','counted');
END $$;

CREATE OR REPLACE FUNCTION app_tracking.admin_service_requests_v1(p_from date,p_until date,p_tool text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
  retained date:=(today-interval '24 months')::date; first_day date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90
    OR p_until>today+1 OR p_tool IS NULL OR p_tool NOT IN ('all','ardo','dalo','palamedes') THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  first_day:=greatest(p_from,retained);
  IF p_until<=first_day THEN
    RETURN jsonb_build_object('error','outside_retention','retained_from',retained);
  END IF;
  SELECT jsonb_build_object('schema_version',1,
    'period',jsonb_build_object('from',p_from,'until',p_until,'covered_from',first_day),
    'scope',jsonb_build_object('tool',p_tool),
    'coverage',jsonb_build_object('unit','origin_version_requests','retained_from',retained,
      'clipped',first_day<>p_from),
    'rows',coalesce(jsonb_agg(jsonb_build_object('day',day,'tool_id',tool_id,
      'distribution',distribution,'channel',channel,'status',status,'count',count::text)
      ORDER BY day,tool_id,distribution,status),'[]'::jsonb)) INTO result
  FROM app_tracking.service_requests_v1
  WHERE day>=first_day AND day<p_until AND (p_tool='all' OR tool_id=p_tool);
  RETURN result;
END $$;
