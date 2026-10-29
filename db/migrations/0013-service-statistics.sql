-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Aggregate functional requests immediately; no request-level or client records.
CREATE TABLE app_tracking.service_requests_v1 (
  day date NOT NULL,
  tool_id text NOT NULL,
  distribution text NOT NULL,
  channel text NOT NULL CHECK(channel='stable'),
  status smallint NOT NULL CHECK(status IN (200,304,503)),
  count bigint NOT NULL CHECK(count BETWEEN 1 AND 1000000000000),
  PRIMARY KEY(day,tool_id,distribution,channel,status),
  CHECK((tool_id='dalo' AND distribution IN ('github','npm','standalone'))
    OR (tool_id='palamedes' AND distribution IN ('github','npm')))
);
REVOKE ALL ON app_tracking.service_requests_v1 FROM PUBLIC;

CREATE FUNCTION app_tracking.count_version_request_v1(p_tool text,p_distribution text,p_channel text,p_status integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  IF p_tool IS NULL OR p_distribution IS NULL OR p_channel IS DISTINCT FROM 'stable'
    OR p_status IS NULL OR p_status NOT IN (200,304,503)
    OR NOT ((p_tool='dalo' AND p_distribution IN ('github','npm','standalone'))
      OR (p_tool='palamedes' AND p_distribution IN ('github','npm'))) THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  INSERT INTO app_tracking.service_requests_v1 AS c VALUES
    ((statement_timestamp() AT TIME ZONE 'UTC')::date,p_tool,p_distribution,p_channel,p_status,1)
  ON CONFLICT(day,tool_id,distribution,channel,status)
    DO UPDATE SET count=least(c.count+1,1000000000000);
  RETURN jsonb_build_object('status','counted');
END $$;
REVOKE ALL ON FUNCTION app_tracking.count_version_request_v1(text,text,text,integer) FROM PUBLIC;

CREATE FUNCTION app_tracking.admin_service_requests_v1(p_from date,p_until date,p_tool text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date;
  retained date:=(today-interval '24 months')::date; first_day date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90
    OR p_until>today+1 OR p_tool IS NULL OR p_tool NOT IN ('all','dalo','palamedes') THEN
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
REVOKE ALL ON FUNCTION app_tracking.admin_service_requests_v1(date,date,text) FROM PUBLIC;

CREATE FUNCTION app_tracking.maintain_service_requests_v1(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN RAISE EXCEPTION 'invalid_limit'; END IF;
  WITH expired AS (
    SELECT ctid FROM app_tracking.service_requests_v1
    WHERE day<((statement_timestamp() AT TIME ZONE 'UTC')::date-interval '24 months')::date
    ORDER BY day LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM app_tracking.service_requests_v1 WHERE ctid IN (SELECT ctid FROM expired);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_tracking.maintain_service_requests_v1(integer) FROM PUBLIC;

-- An unreviewed opt-out definition cannot silently turn on device collectors.
CREATE FUNCTION app_tracking.baseline_catalog_valid_v1(p_metrics jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT FROM jsonb_each(p_metrics) AS m WHERE m.value->>'collection'='opt_out'
    AND (m.value->>'system' IS DISTINCT FROM 'none' OR m.value->'project'='true'::jsonb))
$$;
REVOKE ALL ON FUNCTION app_tracking.baseline_catalog_valid_v1(jsonb) FROM PUBLIC;
ALTER TABLE app_tracking.event_catalog_v1 ADD CONSTRAINT baseline_context_v1
  CHECK(app_tracking.baseline_catalog_valid_v1(metrics));
