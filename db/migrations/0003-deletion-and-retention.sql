-- SPDX-License-Identifier: MIT OR Apache-2.0
ALTER TABLE app_tracking.reporting_installations ADD COLUMN purge_pending boolean
  NOT NULL DEFAULT false CHECK (NOT purge_pending OR state <> 'active');
CREATE INDEX installations_inactivity ON app_tracking.reporting_installations(last_activity_at)
  WHERE state='active';
CREATE INDEX installations_pending_purge ON app_tracking.reporting_installations(transitioned_at)
  WHERE purge_pending;
CREATE INDEX installations_tombstones ON app_tracking.reporting_installations(transitioned_at)
  WHERE state <> 'active';
CREATE INDEX installations_rate_expiry ON app_tracking.reporting_installations((upload_attempts[1]))
  WHERE cardinality(upload_attempts)>0;
CREATE INDEX quotas_retention ON app_tracking.daily_quotas(day);

-- Every future reporting query must use this visibility boundary. There are no
-- materialized usage rollups or shared-cache responses to invalidate in v1.
CREATE VIEW app_tracking.reporting_usage_v1 WITH (security_barrier=true) AS
  SELECT u.*,i.mode FROM app_tracking.usage_counts u
  JOIN app_tracking.reporting_installations i USING(tool_id,installation_id)
  WHERE i.state='active' AND i.last_activity_at > statement_timestamp()-interval '90 days'
    AND u.day > (statement_timestamp() AT TIME ZONE 'UTC')::date-90;

CREATE TABLE app_tracking.maintenance_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  last_attempt_at timestamptz,
  last_progress_at timestamptz,
  last_completed_at timestamptz
);
INSERT INTO app_tracking.maintenance_state(singleton) VALUES(true);

-- Internal bounded primary purge. Callers hold/reacquire the installation lock.
CREATE FUNCTION app_tracking.purge_step_v1(p_tool text,p_id uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE n_usage integer; n_receipts integer; n_quotas integer; pending boolean;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 OR p_limit IS NULL THEN RAISE EXCEPTION 'invalid_maintenance_limit'; END IF;
  PERFORM 1 FROM app_tracking.reporting_installations
    WHERE tool_id=p_tool AND installation_id=p_id AND state <> 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inactive_installation_required'; END IF;
  DELETE FROM app_tracking.usage_counts WHERE ctid IN (SELECT ctid FROM app_tracking.usage_counts
    WHERE tool_id=p_tool AND installation_id=p_id LIMIT p_limit);
  GET DIAGNOSTICS n_usage=ROW_COUNT;
  -- Never cascade an unbounded set of contributions while deleting receipts.
  DELETE FROM app_tracking.telemetry_batches b WHERE b.ctid IN (
    SELECT t.ctid FROM app_tracking.telemetry_batches t
    WHERE t.tool_id=p_tool AND t.installation_id=p_id AND NOT EXISTS (
      SELECT FROM app_tracking.usage_counts u WHERE u.tool_id=t.tool_id
        AND u.installation_id=t.installation_id AND u.batch_id=t.batch_id) LIMIT p_limit);
  GET DIAGNOSTICS n_receipts=ROW_COUNT;
  DELETE FROM app_tracking.daily_quotas WHERE ctid IN (SELECT ctid FROM app_tracking.daily_quotas
    WHERE tool_id=p_tool AND installation_id=p_id LIMIT p_limit);
  GET DIAGNOSTICS n_quotas=ROW_COUNT;
  pending := EXISTS(SELECT FROM app_tracking.usage_counts WHERE tool_id=p_tool AND installation_id=p_id)
    OR EXISTS(SELECT FROM app_tracking.telemetry_batches WHERE tool_id=p_tool AND installation_id=p_id)
    OR EXISTS(SELECT FROM app_tracking.daily_quotas WHERE tool_id=p_tool AND installation_id=p_id);
  UPDATE app_tracking.reporting_installations SET purge_pending=pending
    WHERE tool_id=p_tool AND installation_id=p_id;
  RETURN jsonb_build_object('usage_deleted',n_usage,'receipts_deleted',n_receipts,
    'quotas_deleted',n_quotas,'pending',pending);
END $$;

CREATE FUNCTION app_tracking.delete_installation_v1(p_tool text,p_id uuid,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE item app_tracking.reporting_installations%ROWTYPE; now_at timestamptz; progress jsonb;
BEGIN
  SELECT * INTO item FROM app_tracking.reporting_installations
    WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','installation_not_found'); END IF;
  IF p_token_hash IS NULL OR item.token_hash <> p_token_hash THEN
    RETURN jsonb_build_object('error','unauthorized');
  END IF;
  now_at:=clock_timestamp();
  IF item.state='active' THEN
    UPDATE app_tracking.reporting_installations SET
      state=CASE WHEN item.last_activity_at <= now_at-interval '90 days' THEN 'expired' ELSE 'revoked' END,
      transitioned_at=CASE WHEN item.last_activity_at <= now_at-interval '90 days'
        THEN item.last_activity_at+interval '90 days' ELSE now_at END,
      consent_revision=NULL,consented_at=NULL,mode=NULL,last_activity_at=NULL,
      upload_attempts='{}',purge_pending=true
      WHERE tool_id=p_tool AND installation_id=p_id;
  END IF;
  progress:=app_tracking.purge_step_v1(p_tool,p_id,1000);
  IF (progress->>'pending')::boolean THEN RETURN jsonb_build_object('status','pending'); END IF;
  RETURN jsonb_build_object('status','deleted');
END $$;

CREATE FUNCTION app_tracking.retention_due_v1(p_now timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
  SELECT EXISTS(SELECT FROM app_tracking.reporting_installations WHERE purge_pending)
    OR EXISTS(SELECT FROM app_tracking.reporting_installations WHERE state='active' AND last_activity_at<=p_now-interval '90 days')
    OR EXISTS(SELECT FROM app_tracking.reporting_installations WHERE state<>'active' AND transitioned_at<=p_now-interval '90 days')
    OR EXISTS(SELECT FROM app_tracking.usage_counts WHERE day<=p_now::date-90)
    OR EXISTS(SELECT FROM app_tracking.telemetry_batches WHERE received_at<=p_now-interval '90 days')
    OR EXISTS(SELECT FROM app_tracking.daily_quotas WHERE day<(p_now-interval '300 seconds')::date-6)
    OR EXISTS(SELECT FROM app_tracking.reporting_installations WHERE cardinality(upload_attempts)>0 AND upload_attempts[1]<=p_now-interval '60 seconds')
$$;

-- Authenticated directly by the database; only the app owner/migrator can execute.
-- Durable progress is the committed remaining rows and each purge_pending flag.
CREATE FUNCTION app_tracking.maintain_v1(p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE item app_tracking.reporting_installations%ROWTYPE; now_at timestamptz:=clock_timestamp();
  progress jsonb; more boolean; transitioned integer:=0;
  n_usage integer:=0; n_receipts integer:=0; n_quotas integer:=0; n_tombstones integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid_maintenance_limit'; END IF;
  IF NOT pg_try_advisory_xact_lock(741391606) THEN RETURN jsonb_build_object('busy',true,'more',true); END IF;
  UPDATE app_tracking.maintenance_state SET last_attempt_at=now_at;
  WITH candidates AS (
    (SELECT tool_id,installation_id,0 priority FROM app_tracking.reporting_installations WHERE purge_pending ORDER BY transitioned_at LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,1 FROM app_tracking.reporting_installations WHERE state='active' AND last_activity_at<=now_at-interval '90 days' ORDER BY last_activity_at LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,2 FROM app_tracking.reporting_installations WHERE state<>'active' AND transitioned_at<=now_at-interval '90 days' ORDER BY transitioned_at LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,3 FROM app_tracking.usage_counts WHERE day<=now_at::date-90 ORDER BY day LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,4 FROM app_tracking.telemetry_batches WHERE received_at<=now_at-interval '90 days' ORDER BY received_at LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,5 FROM app_tracking.daily_quotas WHERE day<(now_at-interval '300 seconds')::date-6 ORDER BY day LIMIT 1)
    UNION ALL
    (SELECT tool_id,installation_id,6 FROM app_tracking.reporting_installations WHERE cardinality(upload_attempts)>0 AND upload_attempts[1]<=now_at-interval '60 seconds' ORDER BY upload_attempts[1] LIMIT 1)
  ) SELECT i.* INTO item FROM app_tracking.reporting_installations i
    JOIN (SELECT tool_id,installation_id,min(priority) priority FROM candidates GROUP BY tool_id,installation_id) c
      USING(tool_id,installation_id) ORDER BY c.priority LIMIT 1 FOR UPDATE OF i SKIP LOCKED;
  IF FOUND THEN
    IF item.state='active' AND item.last_activity_at<=now_at-interval '90 days' THEN
      UPDATE app_tracking.reporting_installations SET state='expired',
        transitioned_at=item.last_activity_at+interval '90 days',consent_revision=NULL,
        consented_at=NULL,mode=NULL,last_activity_at=NULL,upload_attempts='{}',purge_pending=true
        WHERE tool_id=item.tool_id AND installation_id=item.installation_id;
      item.state:='expired'; transitioned:=1;
    END IF;
    IF item.state<>'active' THEN
      progress:=app_tracking.purge_step_v1(item.tool_id,item.installation_id,p_limit);
      n_usage:=(progress->>'usage_deleted')::integer;
      n_receipts:=(progress->>'receipts_deleted')::integer;
      n_quotas:=(progress->>'quotas_deleted')::integer;
      IF NOT (progress->>'pending')::boolean THEN
        DELETE FROM app_tracking.reporting_installations WHERE tool_id=item.tool_id
          AND installation_id=item.installation_id AND transitioned_at<=now_at-interval '90 days';
        GET DIAGNOSTICS n_tombstones=ROW_COUNT;
      END IF;
    ELSE
      DELETE FROM app_tracking.usage_counts WHERE ctid IN (SELECT ctid FROM app_tracking.usage_counts
        WHERE tool_id=item.tool_id AND installation_id=item.installation_id AND (day<=now_at::date-90
          OR EXISTS(SELECT FROM app_tracking.telemetry_batches b WHERE b.tool_id=usage_counts.tool_id
            AND b.installation_id=usage_counts.installation_id AND b.batch_id=usage_counts.batch_id
            AND b.received_at<=now_at-interval '90 days')) LIMIT p_limit);
      GET DIAGNOSTICS n_usage=ROW_COUNT;
      DELETE FROM app_tracking.telemetry_batches b WHERE b.ctid IN (
        SELECT t.ctid FROM app_tracking.telemetry_batches t WHERE t.tool_id=item.tool_id
          AND t.installation_id=item.installation_id AND t.received_at<=now_at-interval '90 days'
          AND NOT EXISTS(SELECT FROM app_tracking.usage_counts u WHERE u.tool_id=t.tool_id
            AND u.installation_id=t.installation_id AND u.batch_id=t.batch_id) LIMIT p_limit);
      GET DIAGNOSTICS n_receipts=ROW_COUNT;
      DELETE FROM app_tracking.daily_quotas WHERE ctid IN (SELECT ctid FROM app_tracking.daily_quotas
        WHERE tool_id=item.tool_id AND installation_id=item.installation_id
          AND day<(now_at-interval '300 seconds')::date-6 LIMIT p_limit);
      GET DIAGNOSTICS n_quotas=ROW_COUNT;
      UPDATE app_tracking.reporting_installations SET upload_attempts=ARRAY(
        SELECT t FROM unnest(upload_attempts) t WHERE t>now_at-interval '60 seconds')
        WHERE tool_id=item.tool_id AND installation_id=item.installation_id;
    END IF;
    UPDATE app_tracking.maintenance_state SET last_progress_at=now_at;
  END IF;
  more:=app_tracking.retention_due_v1(clock_timestamp());
  IF NOT more THEN UPDATE app_tracking.maintenance_state SET last_completed_at=clock_timestamp(); END IF;
  RETURN jsonb_build_object('usage_deleted',n_usage,'receipts_deleted',n_receipts,
    'quotas_deleted',n_quotas,'installations_expired',transitioned,'tombstones_deleted',n_tombstones,
    'more',more,'busy',more AND item.installation_id IS NULL);
END $$;
REVOKE ALL ON FUNCTION app_tracking.purge_step_v1(text,uuid,integer),
  app_tracking.delete_installation_v1(text,uuid,text),app_tracking.retention_due_v1(timestamptz),
  app_tracking.maintain_v1(integer) FROM PUBLIC;
