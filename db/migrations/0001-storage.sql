-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Internal storage boundary. Public HTTP validation is implemented in issue #7.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app_tracking;
REVOKE ALL ON SCHEMA app_tracking FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_tracking REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE app_tracking.reporting_installations (
  tool_id text NOT NULL CHECK (tool_id = 'dalo'),
  installation_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  consent_revision text CHECK (consent_revision = 'telemetry-v1'),
  consented_at timestamptz,
  mode text CHECK (mode IN ('local', 'ci')),
  last_activity_at timestamptz,
  transitioned_at timestamptz,
  PRIMARY KEY (tool_id, installation_id),
  CHECK ((state = 'active' AND consent_revision IS NOT NULL AND consented_at IS NOT NULL
    AND mode IS NOT NULL AND last_activity_at IS NOT NULL AND transitioned_at IS NULL)
    OR (state <> 'active' AND consent_revision IS NULL AND consented_at IS NULL
    AND mode IS NULL AND last_activity_at IS NULL AND transitioned_at IS NOT NULL))
);
CREATE TABLE app_tracking.telemetry_batches (
  tool_id text NOT NULL,
  installation_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (tool_id, installation_id, batch_id),
  FOREIGN KEY (tool_id, installation_id)
    REFERENCES app_tracking.reporting_installations ON DELETE CASCADE
);
CREATE INDEX batches_retention ON app_tracking.telemetry_batches (received_at);
CREATE TABLE app_tracking.usage_counts (
  tool_id text NOT NULL,
  installation_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number smallint NOT NULL CHECK (row_number BETWEEN 1 AND 256),
  day date NOT NULL,
  tool_version text NOT NULL CHECK (octet_length(tool_version) BETWEEN 1 AND 128),
  command text NOT NULL CHECK (command ~ '^[a-z]{1,32}$'),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 1000000),
  project_id text CHECK (project_id ~ '^[0-9a-f]{64}$'),
  project_id_version smallint,
  PRIMARY KEY (tool_id, installation_id, batch_id, row_number),
  FOREIGN KEY (tool_id, installation_id, batch_id)
    REFERENCES app_tracking.telemetry_batches ON DELETE CASCADE,
  CHECK ((project_id IS NULL AND project_id_version IS NULL)
    OR (project_id IS NOT NULL AND project_id_version IS NOT NULL AND project_id_version = 1))
);
CREATE INDEX usage_reporting ON app_tracking.usage_counts (tool_id, day);
CREATE INDEX usage_retention ON app_tracking.usage_counts (day);
CREATE TABLE app_tracking.daily_quotas (
  tool_id text NOT NULL,
  installation_id uuid NOT NULL,
  day date NOT NULL,
  count bigint NOT NULL CHECK (count BETWEEN 1 AND 10000000),
  PRIMARY KEY (tool_id, installation_id, day),
  FOREIGN KEY (tool_id, installation_id)
    REFERENCES app_tracking.reporting_installations ON DELETE CASCADE
);

-- UUIDv7 carries protocol creation time, not individual invocation time.
CREATE FUNCTION app_tracking.uuid_created_at(id uuid) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog SET timezone = 'UTC' AS $$
  SELECT to_timestamp(('x' || substring(replace(id::text, '-', ''), 1, 12))::bit(48)::bigint / 1000.0)
$$;

CREATE FUNCTION app_tracking.register_installation(
  p_tool text, p_id uuid, p_token_hash text, p_revision text,
  p_consented_at timestamptz, p_mode text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  item app_tracking.reporting_installations%ROWTYPE;
  now_at timestamptz := clock_timestamp();
  born_at timestamptz := app_tracking.uuid_created_at(p_id);
  inserted integer;
BEGIN
  IF p_tool IS DISTINCT FROM 'dalo' OR p_revision IS DISTINCT FROM 'telemetry-v1'
    OR p_mode IS NULL OR p_mode NOT IN ('local', 'ci')
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_id IS NULL OR p_consented_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_registration';
  END IF;
  -- Claim first, then authenticate the winning immutable declaration under lock.
  -- A rejected fresh declaration rolls the claim back in this same statement.
  INSERT INTO app_tracking.reporting_installations
    (tool_id, installation_id, token_hash, consent_revision, consented_at, mode, last_activity_at)
  VALUES (p_tool, p_id, p_token_hash, p_revision, p_consented_at, p_mode, now_at)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT * INTO STRICT item FROM app_tracking.reporting_installations
    WHERE tool_id = p_tool AND installation_id = p_id FOR UPDATE;
  IF item.token_hash <> p_token_hash THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'unauthorized';
  END IF;
  IF item.state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'installation_inactive';
  END IF;
  IF item.consent_revision <> p_revision OR item.consented_at <> p_consented_at OR item.mode <> p_mode THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'registration_conflict';
  END IF;
  IF item.last_activity_at < now_at - interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'installation_expired';
  END IF;
  IF inserted = 1 THEN
    IF p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR born_at < now_at - interval '300 seconds' OR born_at > now_at + interval '300 seconds'
      OR p_consented_at > least(now_at, born_at) + interval '300 seconds'
      OR p_consented_at < now_at - interval '90 days' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_registration_time';
    END IF;
    RETURN jsonb_build_object('status', 'registered');
  END IF;
  RETURN jsonb_build_object('status', 'duplicate');
END $$;

CREATE FUNCTION app_tracking.accept_batch(
  p_tool text, p_id uuid, p_token_hash text, p_batch uuid, p_hash text, p_rows jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  item app_tracking.reporting_installations%ROWTYPE;
  receipt app_tracking.telemetry_batches%ROWTYPE;
  now_at timestamptz := clock_timestamp();
  born_at timestamptz := app_tracking.uuid_created_at(p_batch);
  total bigint;
BEGIN
  SELECT * INTO item FROM app_tracking.reporting_installations
    WHERE tool_id = p_tool AND installation_id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'installation_not_found';
  END IF;
  IF p_token_hash IS NULL OR item.token_hash <> p_token_hash THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'unauthorized';
  END IF;
  IF item.state <> 'active' OR item.last_activity_at < now_at - interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'installation_inactive';
  END IF;
  SELECT * INTO receipt FROM app_tracking.telemetry_batches
    WHERE tool_id = p_tool AND installation_id = p_id AND batch_id = p_batch;
  IF FOUND AND receipt.received_at > now_at - interval '90 days' THEN
    IF p_hash IS NULL OR receipt.content_hash <> p_hash THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'batch_conflict';
    END IF;
    RETURN jsonb_build_object('status', 'duplicate', 'received_at', receipt.received_at);
  END IF;
  IF p_batch IS NULL OR p_batch::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR born_at < now_at - interval '7 days 300 seconds' OR born_at > now_at + interval '300 seconds'
    OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_batch';
  END IF;
  IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 256 OR octet_length(p_rows::text) > 131072 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'batch_limits';
  END IF;
  SELECT sum((r->>'count')::bigint) INTO total FROM jsonb_array_elements(p_rows) r;
  IF total IS NULL OR total > 10000000 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE (r->>'day')::date < (now_at - interval '300 seconds')::date - 6
      OR (r->>'day')::date > (now_at + interval '300 seconds')::date
      OR (r->>'day')::date > born_at::date OR (r->>'day')::date < item.consented_at::date
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_usage';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
    GROUP BY r - 'count' HAVING count(*) > 1) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'duplicate_dimensions';
  END IF;
  INSERT INTO app_tracking.telemetry_batches VALUES (p_tool, p_id, p_batch, p_hash, now_at);
  INSERT INTO app_tracking.daily_quotas AS q
    SELECT p_tool, p_id, (r->>'day')::date, sum((r->>'count')::bigint)
    FROM jsonb_array_elements(p_rows) r GROUP BY (r->>'day')::date
    ON CONFLICT (tool_id, installation_id, day) DO UPDATE SET count = q.count + EXCLUDED.count;
  INSERT INTO app_tracking.usage_counts
    SELECT p_tool, p_id, p_batch, n::smallint, (r->>'day')::date,
      r->>'tool_version', r->>'command', (r->>'count')::integer,
      r->>'project_id', (r->>'project_id_version')::smallint
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS rows(r, n);
  UPDATE app_tracking.reporting_installations SET last_activity_at = now_at
    WHERE tool_id = p_tool AND installation_id = p_id;
  RETURN jsonb_build_object('status', 'accepted', 'received_at', now_at);
END $$;

-- Candidate shared locking boundary; HTTP deletion and retention jobs are issue #8.
CREATE FUNCTION app_tracking.revoke_installation(p_tool text, p_id uuid, p_token_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE item app_tracking.reporting_installations%ROWTYPE;
BEGIN
  SELECT * INTO item FROM app_tracking.reporting_installations
    WHERE tool_id = p_tool AND installation_id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'installation_not_found'; END IF;
  IF p_token_hash IS NULL OR item.token_hash <> p_token_hash THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'unauthorized';
  END IF;
  IF item.state <> 'active' THEN RETURN; END IF;
  DELETE FROM app_tracking.telemetry_batches WHERE tool_id = p_tool AND installation_id = p_id;
  DELETE FROM app_tracking.daily_quotas WHERE tool_id = p_tool AND installation_id = p_id;
  UPDATE app_tracking.reporting_installations SET state = 'revoked', consent_revision = NULL,
    consented_at = NULL, mode = NULL, last_activity_at = NULL, transitioned_at = clock_timestamp()
    WHERE tool_id = p_tool AND installation_id = p_id;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_tracking FROM PUBLIC;
