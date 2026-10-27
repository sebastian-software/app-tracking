-- SPDX-License-Identifier: MIT OR Apache-2.0
-- This read boundary is granted only to a separate reporting login. Ingestion
-- credentials cannot execute it or read underlying rows.
CREATE FUNCTION app_tracking.admin_usage_v1(p_from date,p_until date,p_tool text,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
  first_day date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90
    OR p_until>today+1 OR p_tool IS NULL OR p_tool NOT IN ('all','dalo','palamedes')
    OR p_mode IS NULL OR p_mode NOT IN ('local','ci') THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  first_day:=greatest(p_from,today-89);
  IF p_until<=first_day THEN
    RETURN jsonb_build_object('error','outside_retention','retained_from',today-89);
  END IF;
  WITH visible AS MATERIALIZED (
    SELECT * FROM app_tracking.reporting_usage_v1 u
    WHERE u.day>=first_day AND u.day<p_until AND u.mode=p_mode
      AND (p_tool='all' OR u.tool_id=p_tool)
  ), totals AS (
    SELECT coalesce(sum(count),0)::text invocations,
      count(DISTINCT (tool_id,installation_id))::text active_installations,
      (count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL))::text active_projects,
      coalesce(sum(count) FILTER(WHERE project_id IS NULL),0)::text unknown_project_invocations
    FROM visible
  ), by_day AS (
    SELECT day,sum(count)::text invocations,
      count(DISTINCT (tool_id,installation_id))::text active_installations,
      (count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL))::text active_projects
    FROM visible GROUP BY day
  ), daily AS (
    SELECT d::date AS day,coalesce(b.invocations,'0') invocations,
      coalesce(b.active_installations,'0') active_installations,
      coalesce(b.active_projects,'0') active_projects
    FROM generate_series(first_day::timestamp,(p_until-1)::timestamp,interval '1 day') d
    LEFT JOIN by_day b ON b.day=d::date
  ), commands AS (
    SELECT tool_id,command,sum(count)::text invocations FROM visible GROUP BY tool_id,command
  ), versions AS (
    SELECT tool_id,tool_version,sum(count) invocations FROM visible GROUP BY tool_id,tool_version
  ), top_versions AS (
    SELECT tool_id,tool_version,invocations::text invocations FROM versions
    ORDER BY versions.invocations DESC,tool_id,tool_version LIMIT 100
  ) SELECT jsonb_build_object(
    'schema_version',1,'period',jsonb_build_object('from',p_from,'until',p_until,
      'covered_from',first_day,'snapshot_at',statement_timestamp()),
    'scope',jsonb_build_object('tool',p_tool,'mode',p_mode),
    'coverage',jsonb_build_object('retained_from',today-89,'clipped',first_day<>p_from,
      'provisional_from',today-6,'has_observations',EXISTS(SELECT FROM visible),
      'versions_truncated',(SELECT count(*)>100 FROM versions)),
    'totals',(SELECT to_jsonb(t) FROM totals t),
    'daily',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY day) FROM daily d),'[]'::jsonb),
    'commands',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY invocations::numeric DESC,tool_id,command) FROM commands c),'[]'::jsonb),
    'versions',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY invocations::numeric DESC,tool_id,tool_version) FROM top_versions v),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_tracking.admin_usage_v1(date,date,text,text) FROM PUBLIC;
