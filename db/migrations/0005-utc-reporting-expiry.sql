-- SPDX-License-Identifier: MIT OR Apache-2.0
-- A view inherits its reader's timezone. Use elapsed hours for inactivity so DST
-- cannot keep expired authority visible; occurrence-day expiry stays explicitly UTC.
CREATE OR REPLACE VIEW app_tracking.reporting_usage_v1 WITH (security_barrier=true) AS
  SELECT u.*,i.mode FROM app_tracking.usage_counts u
  JOIN app_tracking.reporting_installations i USING(tool_id,installation_id)
  WHERE i.state='active' AND i.last_activity_at > statement_timestamp()-interval '2160 hours'
    AND u.day > (statement_timestamp() AT TIME ZONE 'UTC')::date-90;
