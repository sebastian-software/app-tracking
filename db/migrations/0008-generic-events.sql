-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Generic counters remain separate from legacy CLI invocations.
CREATE TABLE app_tracking.event_catalog_v1(tool_id text PRIMARY KEY, metrics jsonb NOT NULL);
INSERT INTO app_tracking.event_catalog_v1 VALUES
('dalo','{"cli.invocation":{"collection":"opt_in","dimensions":{"command":["init","install","migrate","project","promote","target","source","agent","plugin","tool","hook","binary","plan","team","status","next","sync","autosync","adopt","resolve","doctor","audit","approve","instructions","other"]},"system":"full","project":true}}'::jsonb),
('palamedes','{"cli.invocation":{"collection":"opt_in","dimensions":{"command":["extract","lint","audit","report","catalogmerge","catalogconvert","catalogcompile","plugin","other"]},"system":"full","project":true}}'::jsonb),
('ferriki','{"resource.download":{"collection":"opt_in","dimensions":{"kind":["grammar","bytecode","theme"]},"system":"full","project":true},"language.use":{"collection":"opt_in","dimensions":{"language":["rust","javascript","typescript","tsx","json","html","css","python","go","java","c","cpp","bash","yaml","toml","markdown","other"],"source":["explicit","dependency"]},"system":"full","project":true}}'::jsonb);

CREATE TABLE app_tracking.event_installations_v1(
  tool_id text NOT NULL REFERENCES app_tracking.event_catalog_v1,
  installation_id text NOT NULL CHECK(installation_id ~ '^[0-9a-f]{64}$'),
  token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  consented_at bigint NOT NULL,
  mode text NOT NULL CHECK(mode IN ('local','ci')),
  active boolean NOT NULL DEFAULT true,
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tool_id,installation_id)
);
CREATE TABLE app_tracking.event_batches_v1(
  tool_id text NOT NULL REFERENCES app_tracking.event_catalog_v1,
  batch_id text NOT NULL CHECK(batch_id ~ '^[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  collection text NOT NULL CHECK(collection IN ('opt_in','opt_out')),
  installation_id text,
  mode text NOT NULL CHECK(mode IN ('local','ci')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tool_id,batch_id),
  FOREIGN KEY(tool_id,installation_id) REFERENCES app_tracking.event_installations_v1,
  CHECK((collection='opt_in')=(installation_id IS NOT NULL))
);
CREATE INDEX event_batches_retention ON app_tracking.event_batches_v1(received_at);
CREATE INDEX event_batches_installation ON app_tracking.event_batches_v1(tool_id,installation_id);
CREATE TABLE app_tracking.event_counts_v1(
  tool_id text NOT NULL,
  batch_id text NOT NULL,
  row_number smallint NOT NULL CHECK(row_number BETWEEN 1 AND 64),
  day integer NOT NULL,
  metric text NOT NULL,
  tool_version text NOT NULL,
  dimensions jsonb NOT NULL,
  system jsonb,
  count integer NOT NULL CHECK(count BETWEEN 1 AND 1000000),
  project_id text CHECK(project_id ~ '^[0-9a-f]{64}$'),
  project_id_version smallint,
  CHECK((project_id IS NULL AND project_id_version IS NULL) OR (project_id IS NOT NULL AND project_id_version IS NOT NULL AND project_id_version=1)),
  PRIMARY KEY(tool_id,batch_id,row_number),
  FOREIGN KEY(tool_id,batch_id) REFERENCES app_tracking.event_batches_v1 ON DELETE CASCADE
);
CREATE INDEX event_counts_reporting ON app_tracking.event_counts_v1(tool_id,day,metric);
CREATE TABLE app_tracking.event_quotas_v1(
  tool_id text NOT NULL,
  principal text NOT NULL,
  day integer NOT NULL,
  count bigint NOT NULL CHECK(count BETWEEN 1 AND 10000000),
  PRIMARY KEY(tool_id,principal,day)
);

CREATE FUNCTION app_tracking.accept_events_v1(
  p_tool text,p_collection text,p_id text,p_token_hash text,p_consented bigint,
  p_mode text,p_batch text,p_hash text,p_rows jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE defs jsonb; item app_tracking.event_installations_v1%ROWTYPE;
  receipt app_tracking.event_batches_v1%ROWTYPE; r jsonb; def jsonb; d record;
  today integer := floor(extract(epoch FROM clock_timestamp())/86400)::integer;
  quota_principal text; inserted integer;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  SELECT metrics INTO defs FROM app_tracking.event_catalog_v1 WHERE tool_id=p_tool;
  IF defs IS NULL THEN RETURN jsonb_build_object('error','unsupported_tool'); END IF;
  IF p_collection IS NULL OR p_collection NOT IN ('opt_in','opt_out') OR p_mode IS NULL OR p_mode NOT IN ('local','ci')
    OR p_batch IS NULL OR p_batch !~ '^[0-9a-f]{64}$' OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR octet_length(p_rows::text)>131072
    OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 64 THEN
    RETURN jsonb_build_object('error','invalid_request');
  END IF;
  -- Serialize first claims, receipt checks and day quotas for this small tool stream.
  PERFORM pg_advisory_xact_lock(hashtextextended('app-tracking-events-v1:'||p_tool,0));
  IF p_collection='opt_in' THEN
    IF p_id IS NULL OR p_id !~ '^[0-9a-f]{64}$' OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
      OR p_consented IS NULL THEN RETURN jsonb_build_object('error','consent_required'); END IF;
    IF p_consented>now_ms+300000 THEN
      RETURN jsonb_build_object('error','consent_required'); END IF;
    INSERT INTO app_tracking.event_installations_v1(tool_id,installation_id,token_hash,consented_at,mode)
      VALUES(p_tool,p_id,p_token_hash,p_consented,p_mode) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted=ROW_COUNT;
    IF inserted>0 AND p_consented<now_ms-7776000000 THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='consent_required'; END IF;
    SELECT * INTO STRICT item FROM app_tracking.event_installations_v1 WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
    IF item.token_hash<>p_token_hash THEN RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='unauthorized'; END IF;
    IF NOT item.active THEN RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='installation_revoked'; END IF;
    IF item.last_activity_at<=clock_timestamp()-interval '90 days' THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='installation_expired'; END IF;
    IF item.consented_at<>p_consented OR item.mode<>p_mode THEN RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='registration_conflict'; END IF;
    quota_principal:=p_id;
  ELSE
    IF p_id IS NOT NULL OR p_token_hash IS NOT NULL OR p_consented IS NOT NULL THEN
      RETURN jsonb_build_object('error','invalid_request'); END IF;
    quota_principal:='baseline:'||p_mode;
  END IF;
  SELECT * INTO receipt FROM app_tracking.event_batches_v1 WHERE tool_id=p_tool AND batch_id=p_batch;
  IF FOUND THEN
    IF receipt.content_hash<>p_hash OR receipt.installation_id IS DISTINCT FROM p_id THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='batch_conflict'; END IF;
    RETURN jsonb_build_object('status','duplicate');
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    def:=defs->(r->>'metric');
    IF def IS NULL OR def->>'collection'<>p_collection OR r->>'collection'<>p_collection
      OR jsonb_typeof(r)<>'object' OR NOT r ?& ARRAY['day','metric','collection','tool_version','dimensions','count']
      OR (r-ARRAY['day','metric','collection','tool_version','dimensions','count','system','project_id','project_id_version'])<>'{}'::jsonb
      OR jsonb_typeof(r->'day')<>'number' OR r->>'day' !~ '^[0-9]{1,7}$'
      OR (r->>'day')::integer NOT BETWEEN today-6 AND today
      OR jsonb_typeof(r->'count')<>'number' OR r->>'count' !~ '^[1-9][0-9]{0,6}$'
      OR (r->>'count')::integer NOT BETWEEN 1 AND 1000000
      OR jsonb_typeof(r->'tool_version')<>'string' OR length(r->>'tool_version')>128
      OR r->>'tool_version' !~ '^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
      OR jsonb_typeof(r->'dimensions')<>'object' THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(r->'dimensions'))<>(SELECT count(*) FROM jsonb_object_keys(def->'dimensions')) THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    FOR d IN SELECT key,value FROM jsonb_each(def->'dimensions') LOOP
      IF NOT (d.value @> jsonb_build_array(r->'dimensions'->d.key)) THEN
        RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    END LOOP;
    IF (r ? 'project_id') IS DISTINCT FROM (r ? 'project_id_version')
      OR ((r ? 'project_id') AND (p_collection<>'opt_in' OR def->'project' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(r->'project_id') IS DISTINCT FROM 'string' OR r->>'project_id' !~ '^[0-9a-f]{64}$'
        OR r->'project_id_version' IS DISTINCT FROM '1'::jsonb)) THEN
      RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    IF def->>'system'='none' THEN
      IF r ? 'system' THEN RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    ELSE
      IF jsonb_typeof(r->'system') IS DISTINCT FROM 'object'
        OR NOT (r->'system') ?& ARRAY['os','os_version','arch','cpu_family']
        OR ((r->'system')-ARRAY['os','os_version','arch','cpu_family','linux'])<>'{}'::jsonb
        OR jsonb_typeof(r->'system'->'os') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'system'->'arch') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'system'->'os_version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'system'->'cpu_family') IS DISTINCT FROM 'string'
        OR r->'system'->>'os' NOT IN ('macos','linux','windows','other')
        OR r->'system'->>'arch' NOT IN ('aarch64','x86_64','x86','arm','other')
        OR r->'system'->>'os_version' !~ '^(unknown|[0-9]{1,5}(\.[0-9]{1,5}){0,3})$'
        OR r->'system'->>'cpu_family' !~ '^(unknown|other|intel|amd|apple_m[1-9])$'
        OR (def->>'system'='platform' AND (r->'system'->>'os_version'<>'unknown' OR r->'system'->>'cpu_family'<>'unknown')) THEN
        RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    END IF;
    IF (r->'system') ? 'linux' THEN
      IF def->>'system'<>'full' OR r->'system'->>'os'<>'linux'
        OR jsonb_typeof(r->'system'->'linux') IS DISTINCT FROM 'object'
        OR NOT (r->'system'->'linux') ?& ARRAY['distribution','distribution_version','kernel_version']
        OR ((r->'system'->'linux')-ARRAY['distribution','distribution_version','kernel_version'])<>'{}'::jsonb
        OR jsonb_typeof(r->'system'->'linux'->'distribution') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'system'->'linux'->'distribution_version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'system'->'linux'->'kernel_version') IS DISTINCT FROM 'string'
        OR r->'system'->'linux'->>'distribution' NOT IN ('ubuntu','debian','fedora','arch','alpine','nixos','rhel','centos','rocky','opensuse','linuxmint','pop','other','unknown')
        OR r->'system'->'linux'->>'distribution_version' !~ '^(unknown|[0-9]{1,5}(\.[0-9]{1,5}){0,3})$'
        OR r->'system'->'linux'->>'kernel_version' !~ '^(unknown|[0-9]{1,5}(\.[0-9]{1,5}){0,3})$' THEN
        RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='invalid_request'; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) AS entries(entry) GROUP BY entry-'count' HAVING count(*)>1)
    OR (SELECT sum((entry->>'count')::bigint) FROM jsonb_array_elements(p_rows) AS entries(entry))>10000000 THEN
    RAISE EXCEPTION USING ERRCODE='PT001',MESSAGE='count_limit'; END IF;
  FOR d IN SELECT (entry->>'day')::integer AS event_day,sum((entry->>'count')::bigint) AS event_total FROM jsonb_array_elements(p_rows) AS entries(entry) GROUP BY 1 LOOP
    INSERT INTO app_tracking.event_quotas_v1 AS q VALUES(p_tool,quota_principal,d.event_day,d.event_total)
      ON CONFLICT(tool_id,principal,day) DO UPDATE SET count=q.count+excluded.count;
  END LOOP;
  INSERT INTO app_tracking.event_batches_v1(tool_id,batch_id,content_hash,collection,installation_id,mode)
    VALUES(p_tool,p_batch,p_hash,p_collection,p_id,p_mode);
  INSERT INTO app_tracking.event_counts_v1
    SELECT p_tool,p_batch,entries.n::smallint,(entry->>'day')::integer,entry->>'metric',entry->>'tool_version',entry->'dimensions',entry->'system',(entry->>'count')::integer,entry->>'project_id',(entry->>'project_id_version')::smallint
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS entries(entry,n);
  IF p_id IS NOT NULL THEN UPDATE app_tracking.event_installations_v1 SET last_activity_at=clock_timestamp()
    WHERE tool_id=p_tool AND installation_id=p_id; END IF;
  RETURN jsonb_build_object('status','accepted');
EXCEPTION WHEN SQLSTATE 'PT001' THEN RETURN jsonb_build_object('error',SQLERRM);
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN jsonb_build_object('error','invalid_request');
  WHEN check_violation THEN RETURN jsonb_build_object('error','count_limit');
END $$;

CREATE FUNCTION app_tracking.delete_events_v1(p_tool text,p_id text,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item app_tracking.event_installations_v1%ROWTYPE;
BEGIN
  SELECT * INTO item FROM app_tracking.event_installations_v1 WHERE tool_id=p_tool AND installation_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','installation_not_found'); END IF;
  IF p_token_hash IS NULL OR item.token_hash<>p_token_hash THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  UPDATE app_tracking.event_installations_v1 SET active=false,last_activity_at=CASE WHEN active THEN clock_timestamp() ELSE last_activity_at END WHERE tool_id=p_tool AND installation_id=p_id;
  DELETE FROM app_tracking.event_batches_v1 WHERE (tool_id,batch_id) IN
    (SELECT tool_id,batch_id FROM app_tracking.event_batches_v1 WHERE tool_id=p_tool AND installation_id=p_id LIMIT 100);
  IF EXISTS(SELECT FROM app_tracking.event_batches_v1 WHERE tool_id=p_tool AND installation_id=p_id) THEN
    RETURN jsonb_build_object('status','pending'); END IF;
  RETURN jsonb_build_object('status','deleted');
END $$;

CREATE FUNCTION app_tracking.maintain_events_v1(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE removed integer; next_removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_maintenance_limit'; END IF;
  DELETE FROM app_tracking.event_counts_v1 WHERE ctid IN
    (SELECT ctid FROM app_tracking.event_counts_v1 WHERE day<=floor(extract(epoch FROM clock_timestamp())/86400)::integer-90 LIMIT p_limit*64);
  GET DIAGNOSTICS removed=ROW_COUNT;
  DELETE FROM app_tracking.event_batches_v1 WHERE (tool_id,batch_id) IN
    (SELECT tool_id,batch_id FROM app_tracking.event_batches_v1 WHERE received_at<=clock_timestamp()-interval '90 days' LIMIT p_limit);
  GET DIAGNOSTICS next_removed=ROW_COUNT;
  removed:=removed+next_removed;
  DELETE FROM app_tracking.event_installations_v1 i WHERE (tool_id,installation_id) IN
    (SELECT tool_id,installation_id FROM app_tracking.event_installations_v1 e WHERE e.last_activity_at<=clock_timestamp()-interval '90 days'
      AND NOT EXISTS(SELECT FROM app_tracking.event_batches_v1 b WHERE b.tool_id=e.tool_id AND b.installation_id=e.installation_id) LIMIT p_limit);
  GET DIAGNOSTICS next_removed=ROW_COUNT;
  removed:=removed+next_removed;
  DELETE FROM app_tracking.event_quotas_v1 WHERE ctid IN
    (SELECT ctid FROM app_tracking.event_quotas_v1 WHERE day<floor(extract(epoch FROM clock_timestamp())/86400)::integer-90 LIMIT p_limit);
  GET DIAGNOSTICS next_removed=ROW_COUNT;
  RETURN removed+next_removed;
END $$;

CREATE VIEW app_tracking.reporting_events_v1 WITH(security_barrier=true) AS
  SELECT e.*,b.collection,b.installation_id,b.mode FROM app_tracking.event_counts_v1 e
    JOIN app_tracking.event_batches_v1 b USING(tool_id,batch_id)
    LEFT JOIN app_tracking.event_installations_v1 i USING(tool_id,installation_id)
  WHERE e.day>floor(extract(epoch FROM statement_timestamp())/86400)::integer-90
    AND (b.collection='opt_out' OR (i.active AND i.last_activity_at>statement_timestamp()-interval '90 days'));

-- Schema-local default privileges do not remove PostgreSQL's global PUBLIC
-- EXECUTE default. Revoke each new SECURITY DEFINER function explicitly.
REVOKE ALL ON FUNCTION app_tracking.accept_events_v1(text,text,text,text,bigint,text,text,text,jsonb),
  app_tracking.delete_events_v1(text,text,text),app_tracking.maintain_events_v1(integer) FROM PUBLIC;
