-- SPDX-License-Identifier: MIT OR Apache-2.0
-- Optional cross-tool profile linking remains disabled until separately reviewed.
CREATE TABLE app_tracking.profile_policy_v1(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  review_reference text,
  CHECK(NOT enabled OR review_reference IS NOT NULL)
);
INSERT INTO app_tracking.profile_policy_v1(singleton) VALUES(true);
CREATE TABLE app_tracking.shared_profiles_v1(
  profile_id text PRIMARY KEY CHECK(profile_id ~ '^[0-9a-f]{64}$'),
  token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK(active=(revoked_at IS NULL))
);
CREATE TABLE app_tracking.profile_links_v1(
  tool_id text NOT NULL,
  installation_id text NOT NULL,
  enabled boolean NOT NULL,
  changed_at bigint NOT NULL CHECK(changed_at>=0),
  profile_id text REFERENCES app_tracking.shared_profiles_v1(profile_id),
  eligible_from date NOT NULL,
  PRIMARY KEY(tool_id,installation_id),
  FOREIGN KEY(tool_id,installation_id) REFERENCES app_tracking.event_installations_v1(tool_id,installation_id) ON DELETE CASCADE,
  CHECK(enabled=(profile_id IS NOT NULL))
);
CREATE INDEX profile_links_profile ON app_tracking.profile_links_v1(profile_id) WHERE enabled;

CREATE FUNCTION app_tracking.configure_profiles_v1(p_enabled boolean,p_review text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_enabled IS NULL OR (p_enabled AND (p_review IS NULL OR length(p_review) NOT BETWEEN 1 AND 256 OR p_review ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid_profile_configuration'; END IF;
  PERFORM pg_advisory_xact_lock(741391607);
  UPDATE app_tracking.profile_policy_v1 SET enabled=p_enabled,review_reference=p_review WHERE singleton;
END $$;

CREATE FUNCTION app_tracking.set_profile_link_v1(p_tool text,p_id text,p_token_hash text,p_enabled boolean,p_changed_at bigint,p_profile text,p_profile_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE identity app_tracking.event_installations_v1%ROWTYPE; previous app_tracking.profile_links_v1%ROWTYPE;
  profile app_tracking.shared_profiles_v1%ROWTYPE; had_previous boolean;
  now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF p_tool IS NULL OR p_tool NOT IN ('dalo','palamedes','ferriki') OR p_id IS NULL OR p_id !~ '^[0-9a-f]{64}$'
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

CREATE FUNCTION app_tracking.reset_profile_v1(p_profile text,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE profile app_tracking.shared_profiles_v1%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(741391607);
  SELECT * INTO profile FROM app_tracking.shared_profiles_v1 WHERE profile_id=p_profile FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','installation_not_found'); END IF;
  IF p_token_hash IS NULL OR profile.token_hash<>p_token_hash THEN RETURN jsonb_build_object('error','unauthorized'); END IF;
  IF profile.active THEN
    UPDATE app_tracking.shared_profiles_v1 SET active=false,revoked_at=clock_timestamp(),changed_at=clock_timestamp() WHERE profile_id=p_profile;
    UPDATE app_tracking.profile_links_v1 SET enabled=false,profile_id=NULL,
      changed_at=greatest(changed_at,floor(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE profile_id=p_profile;
  END IF;
  RETURN jsonb_build_object('status','deleted');
END $$;

CREATE FUNCTION app_tracking.unlink_revoked_identity_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    PERFORM pg_advisory_xact_lock(741391607);
    UPDATE app_tracking.shared_profiles_v1 SET changed_at=clock_timestamp() WHERE profile_id IN
      (SELECT profile_id FROM app_tracking.profile_links_v1 WHERE tool_id=OLD.tool_id AND installation_id=OLD.installation_id);
    DELETE FROM app_tracking.profile_links_v1 WHERE tool_id=OLD.tool_id AND installation_id=OLD.installation_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER unlink_revoked_identity AFTER UPDATE OF active ON app_tracking.event_installations_v1
  FOR EACH ROW EXECUTE FUNCTION app_tracking.unlink_revoked_identity_v1();

CREATE FUNCTION app_tracking.maintain_profiles_v1()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(741391607);
  DELETE FROM app_tracking.shared_profiles_v1 p WHERE profile_id IN (SELECT profile_id FROM app_tracking.shared_profiles_v1 s
    WHERE (NOT s.active AND s.revoked_at<=clock_timestamp()-interval '90 days') OR
      (s.active AND s.changed_at<=clock_timestamp()-interval '90 days' AND NOT EXISTS(
        SELECT FROM app_tracking.profile_links_v1 l JOIN app_tracking.event_installations_v1 i USING(tool_id,installation_id)
        WHERE l.profile_id=s.profile_id AND l.enabled AND i.active AND i.last_activity_at>clock_timestamp()-interval '90 days')) LIMIT 100)
    AND NOT EXISTS(SELECT FROM app_tracking.profile_links_v1 l WHERE l.profile_id=p.profile_id);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed=100;
END $$;

CREATE FUNCTION app_tracking.admin_profiles_v1(p_from date,p_until date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; result jsonb;
BEGIN
  IF p_from IS NULL OR p_until IS NULL OR p_until<=p_from OR p_until-p_from>90 OR p_until>today+1 THEN RETURN jsonb_build_object('error','invalid_request'); END IF;
  IF p_from<today-89 THEN RETURN jsonb_build_object('error','outside_retention','retained_from',today-89); END IF;
  WITH visible AS MATERIALIZED (
    SELECT e.tool_id,e.installation_id,e.project_id_version,e.project_id,l.profile_id
    FROM app_tracking.reporting_events_v1 e
    JOIN app_tracking.profile_links_v1 l USING(tool_id,installation_id)
    JOIN app_tracking.shared_profiles_v1 p USING(profile_id)
    WHERE l.enabled AND p.active AND e.mode='local' AND e.collection='opt_in'
      AND e.day>=l.eligible_from-date '1970-01-01'
      AND e.day>=p_from-date '1970-01-01' AND e.day<p_until-date '1970-01-01'
  ), members AS (
    SELECT profile_id,array_agg(DISTINCT tool_id ORDER BY tool_id) AS tools FROM visible GROUP BY profile_id
  ), combinations AS (SELECT tools,count(*)::text AS profiles FROM members GROUP BY tools)
  SELECT jsonb_build_object('schema_version',1,'enabled',policy.enabled,'unit','linked_local_profiles',
    'period',jsonb_build_object('from',p_from,'until',p_until,'snapshot_at',statement_timestamp()),
    'totals',jsonb_build_object('profiles',CASE WHEN policy.enabled THEN (SELECT count(*)::text FROM members) ELSE '0' END,
      'installations',CASE WHEN policy.enabled THEN (SELECT count(DISTINCT (tool_id,installation_id))::text FROM visible) ELSE '0' END,
      'projects',CASE WHEN policy.enabled THEN (SELECT count(DISTINCT (project_id_version,project_id)) FILTER(WHERE project_id IS NOT NULL)::text FROM visible) ELSE '0' END),
    'combinations',CASE WHEN policy.enabled THEN coalesce((SELECT jsonb_agg(jsonb_build_object('tools',tools,'profiles',profiles) ORDER BY tools) FROM combinations),'[]'::jsonb) ELSE '[]'::jsonb END)
    INTO result FROM app_tracking.profile_policy_v1 policy WHERE singleton;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_tracking.configure_profiles_v1(boolean,text),
  app_tracking.set_profile_link_v1(text,text,text,boolean,bigint,text,text),app_tracking.reset_profile_v1(text,text),
  app_tracking.unlink_revoked_identity_v1(),app_tracking.maintain_profiles_v1(),app_tracking.admin_profiles_v1(date,date) FROM PUBLIC;
