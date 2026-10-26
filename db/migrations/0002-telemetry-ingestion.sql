-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Public v1 operations return fixed outcomes, never provider/SQL error messages.
ALTER TABLE app_tracking.reporting_installations ADD COLUMN upload_attempts timestamptz[]
  NOT NULL DEFAULT '{}' CHECK (cardinality(upload_attempts) <= 10);
CREATE TABLE app_tracking.command_catalog_v1 (
  command text PRIMARY KEY CHECK (command ~ '^[a-z]{1,32}$'),
  accept_new boolean NOT NULL DEFAULT true
);
INSERT INTO app_tracking.command_catalog_v1(command) VALUES
  ('init'),('install'),('migrate'),('project'),('promote'),('target'),('source'),
  ('agent'),('plugin'),('tool'),('hook'),('binary'),('plan'),('team'),('status'),
  ('next'),('sync'),('autosync'),('adopt'),('resolve'),('doctor'),('audit'),
  ('approve'),('instructions'),('other');

CREATE FUNCTION app_tracking.register_installation_v1(
  p_tool text, p_id uuid, p_token_hash text, p_revision text,
  p_consented_at timestamptz, p_mode text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  item app_tracking.reporting_installations%ROWTYPE;
  now_at timestamptz;
  born_at timestamptz := app_tracking.uuid_created_at(p_id);
  inserted integer;
BEGIN
  IF p_tool IS DISTINCT FROM 'dalo' OR p_id IS NULL OR p_token_hash IS NULL
    OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_consented_at IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('local','ci') THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  -- Insert a candidate declaration, then authenticate the immutable winning row.
  -- Every rejected candidate is rolled back by this block's exception handler.
  INSERT INTO app_tracking.reporting_installations
    (tool_id,installation_id,token_hash,consent_revision,consented_at,mode,last_activity_at)
    VALUES (p_tool,p_id,p_token_hash,'telemetry-v1',p_consented_at,p_mode,clock_timestamp())
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT * INTO STRICT item FROM app_tracking.reporting_installations
    WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  now_at := clock_timestamp();
  IF item.token_hash <> p_token_hash THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='unauthorized';
  END IF;
  IF item.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='PT001',
      MESSAGE=CASE WHEN item.state='revoked' THEN 'installation_revoked' ELSE 'installation_expired' END;
  END IF;
  IF item.last_activity_at <= now_at - interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='installation_expired';
  END IF;
  IF inserted = 0 THEN
    IF item.consent_revision IS DISTINCT FROM p_revision OR item.consented_at <> p_consented_at OR item.mode <> p_mode THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='registration_conflict';
    END IF;
    RETURN jsonb_build_object('status','duplicate');
  END IF;
  IF p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='invalid_request';
  END IF;
  IF born_at > now_at + interval '300 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='clock_skew';
  END IF;
  IF born_at < now_at - interval '300 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='installation_expired';
  END IF;
  IF p_consented_at > least(now_at,born_at) + interval '300 seconds' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='clock_skew';
  END IF;
  IF p_revision IS DISTINCT FROM 'telemetry-v1' OR p_consented_at < now_at - interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='consent_required';
  END IF;
  RETURN jsonb_build_object('status','registered');
EXCEPTION WHEN SQLSTATE 'PT001' THEN
  RETURN jsonb_build_object('error',SQLERRM);
END $$;

CREATE FUNCTION app_tracking.accept_batch_v1(
  p_tool text, p_id uuid, p_token_hash text, p_batch uuid, p_hash text,
  p_revision text, p_rows jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  item app_tracking.reporting_installations%ROWTYPE;
  receipt app_tracking.telemetry_batches%ROWTYPE;
  now_at timestamptz;
  born_at timestamptz := app_tracking.uuid_created_at(p_batch);
  attempts timestamptz[];
  total bigint;
BEGIN
  SELECT * INTO item FROM app_tracking.reporting_installations
    WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','installation_not_found'); END IF;
  IF p_token_hash IS NULL OR item.token_hash <> p_token_hash THEN
    RETURN jsonb_build_object('error','unauthorized');
  END IF;
  now_at := clock_timestamp();
  IF item.state <> 'active' THEN
    RETURN jsonb_build_object('error',CASE WHEN item.state='revoked' THEN 'installation_revoked' ELSE 'installation_expired' END);
  END IF;
  IF item.last_activity_at <= now_at - interval '90 days' THEN
    RETURN jsonb_build_object('error','installation_expired');
  END IF;
  SELECT coalesce(array_agg(t),'{}'::timestamptz[]) INTO attempts
    FROM unnest(item.upload_attempts) t WHERE t > now_at - interval '60 seconds';
  UPDATE app_tracking.reporting_installations SET upload_attempts=attempts
    WHERE tool_id=p_tool AND installation_id=p_id;
  IF cardinality(attempts) >= 10 THEN RETURN jsonb_build_object('error','rate_limited'); END IF;
  UPDATE app_tracking.reporting_installations SET upload_attempts=array_append(attempts,now_at)
    WHERE tool_id=p_tool AND installation_id=p_id;
  -- Rejected authenticated attempts spend the rate budget, but never usage quota.
  -- This subtransaction rolls back all receipt/contribution writes on rejection.
  BEGIN
    IF item.consent_revision IS DISTINCT FROM p_revision THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='consent_required';
    END IF;
    SELECT * INTO receipt FROM app_tracking.telemetry_batches
      WHERE tool_id=p_tool AND installation_id=p_id AND batch_id=p_batch;
    IF FOUND AND receipt.received_at > now_at - interval '90 days' THEN
      IF p_hash IS NULL OR receipt.content_hash <> p_hash THEN
        RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='batch_conflict';
      END IF;
      RETURN jsonb_build_object('status','duplicate','received_at',receipt.received_at);
    END IF;
    IF p_batch IS NULL OR p_batch::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
      OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='invalid_request';
    END IF;
    IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 256 OR octet_length(p_rows::text) > 131072 THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='invalid_request';
    END IF;
    IF born_at > now_at + interval '300 seconds' THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='clock_skew';
    END IF;
    IF born_at < now_at - interval '7 days 300 seconds' THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='batch_expired';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p_rows) r WHERE
      (r->>'day')::date < (now_at - interval '300 seconds')::date - 6
      OR (r->>'day')::date > (now_at + interval '300 seconds')::date
      OR (r->>'day')::date > born_at::date OR (r->>'day')::date < item.consented_at::date) THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='invalid_usage_day';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p_rows) r GROUP BY r - 'count' HAVING count(*) > 1) THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='duplicate_dimensions';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(p_rows) r LEFT JOIN app_tracking.command_catalog_v1 c
      ON c.command=r->>'command' WHERE c.command IS NULL OR NOT c.accept_new) THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='invalid_request';
    END IF;
    SELECT sum((r->>'count')::bigint) INTO total FROM jsonb_array_elements(p_rows) r;
    IF total IS NULL OR total > 10000000 OR EXISTS (SELECT FROM jsonb_array_elements(p_rows) r
      WHERE (r->>'count')::numeric NOT BETWEEN 1 AND 1000000 OR (r->>'count')::numeric <> trunc((r->>'count')::numeric)) THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='count_limit';
    END IF;
    IF EXISTS (SELECT FROM (SELECT (r->>'day')::date AS usage_day,sum((r->>'count')::bigint) AS usage_count
      FROM jsonb_array_elements(p_rows) r GROUP BY (r->>'day')::date) d
      LEFT JOIN app_tracking.daily_quotas q ON q.tool_id=p_tool AND q.installation_id=p_id AND q.day=d.usage_day
      WHERE d.usage_count + coalesce(q.count,0) > 10000000) THEN
      RAISE EXCEPTION USING ERRCODE='PT001', MESSAGE='count_limit';
    END IF;
    INSERT INTO app_tracking.telemetry_batches VALUES (p_tool,p_id,p_batch,p_hash,now_at);
    INSERT INTO app_tracking.daily_quotas AS q
      SELECT p_tool,p_id,(r->>'day')::date,sum((r->>'count')::bigint)
      FROM jsonb_array_elements(p_rows) r GROUP BY (r->>'day')::date
      ON CONFLICT (tool_id,installation_id,day) DO UPDATE SET count=q.count+EXCLUDED.count;
    INSERT INTO app_tracking.usage_counts
      SELECT p_tool,p_id,p_batch,n::smallint,(r->>'day')::date,r->>'tool_version',r->>'command',
        (r->>'count')::integer,r->>'project_id',(r->>'project_id_version')::smallint
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS rows(r,n);
    UPDATE app_tracking.reporting_installations SET last_activity_at=now_at
      WHERE tool_id=p_tool AND installation_id=p_id;
    RETURN jsonb_build_object('status','accepted','received_at',now_at);
  EXCEPTION WHEN SQLSTATE 'PT001' THEN
    RETURN jsonb_build_object('error',SQLERRM);
  END;
END $$;
REVOKE ALL ON FUNCTION app_tracking.register_installation_v1(text,uuid,text,text,timestamptz,text),
  app_tracking.accept_batch_v1(text,uuid,text,uuid,text,text,jsonb) FROM PUBLIC;

-- Keep the existing synthetic revocation boundary compatible with new rate state.
CREATE OR REPLACE FUNCTION app_tracking.revoke_installation(p_tool text,p_id uuid,p_token_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE item app_tracking.reporting_installations%ROWTYPE;
BEGIN
  SELECT * INTO item FROM app_tracking.reporting_installations
    WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='installation_not_found'; END IF;
  IF p_token_hash IS NULL OR item.token_hash <> p_token_hash THEN
    RAISE EXCEPTION USING ERRCODE='28000', MESSAGE='unauthorized';
  END IF;
  IF item.state <> 'active' THEN RETURN; END IF;
  DELETE FROM app_tracking.telemetry_batches WHERE tool_id=p_tool AND installation_id=p_id;
  DELETE FROM app_tracking.daily_quotas WHERE tool_id=p_tool AND installation_id=p_id;
  UPDATE app_tracking.reporting_installations SET state='revoked',consent_revision=NULL,
    consented_at=NULL,mode=NULL,last_activity_at=NULL,transitioned_at=clock_timestamp(),upload_attempts='{}'
    WHERE tool_id=p_tool AND installation_id=p_id;
END $$;
