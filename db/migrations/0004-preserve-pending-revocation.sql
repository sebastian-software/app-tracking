-- SPDX-License-Identifier: MIT OR Apache-2.0
CREATE OR REPLACE FUNCTION app_tracking.delete_installation_v1(p_tool text,p_id uuid,p_token_hash text)
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
  BEGIN
    progress:=app_tracking.purge_step_v1(p_tool,p_id,1000);
  EXCEPTION WHEN query_canceled OR lock_not_available THEN
    -- Roll back this purge page, but preserve the authenticated revocation above.
    -- Pending work is not a deletion acknowledgement; the worker/retry resumes it.
    RETURN jsonb_build_object('status','pending');
  END;
  IF (progress->>'pending')::boolean THEN RETURN jsonb_build_object('status','pending'); END IF;
  RETURN jsonb_build_object('status','deleted');
END $$;

REVOKE ALL ON FUNCTION app_tracking.delete_installation_v1(text,uuid,text) FROM PUBLIC;
