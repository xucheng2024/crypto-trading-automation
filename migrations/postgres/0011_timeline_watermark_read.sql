-- Timeline jobs need the reconciliation fence but remain strictly read-only.
-- Production principals are environment-prefixed; zero matches is valid for
-- local/test databases where the managed identity role is not provisioned.
DO $$
DECLARE
  timeline_role text;
BEGIN
  FOR timeline_role IN
    SELECT rolname FROM pg_roles WHERE rolname LIKE '%-timeline-read'
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE sync_watermarks TO %I', timeline_role);
  END LOOP;
END
$$;
