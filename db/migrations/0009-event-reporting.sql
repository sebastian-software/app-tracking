-- SPDX-License-Identifier: MIT OR Apache-2.0
-- A separate aggregate-only read boundary; no change to collection or retention.
CREATE FUNCTION app_tracking.admin_events_v1(p_from date,p_until date,p_tool text,p_mode text,p_metric text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
  first_day date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90
    OR p_until>today+1 OR p_tool IS NULL OR p_tool NOT IN ('all','dalo','palamedes','ferriki')
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
REVOKE ALL ON FUNCTION app_tracking.admin_events_v1(date,date,text,text,text) FROM PUBLIC;
