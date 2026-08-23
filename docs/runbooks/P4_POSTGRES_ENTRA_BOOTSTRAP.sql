-- REVIEW-ONLY TEMPLATE. Azure administrator generates/reviews this; do not run
-- it from the Engine or Maintenance containers. Replace only placeholders.
-- Migration identity is separate from engine, maintenance, and positions-read identities.
-- Run this template with psql: pgaadauth is installed in the `postgres`
-- database, while schema ownership and object grants belong in DATABASE.
\connect postgres
BEGIN;
SELECT * FROM pgaadauth_create_principal_with_oid('<MIGRATION_APP_NAME>', '<MIGRATION_SP_OBJECT_ID>', 'service', false, false);
SELECT * FROM pgaadauth_create_principal_with_oid('<ENGINE_MI_NAME>', '<ENGINE_MI_OBJECT_ID>', 'service', false, false);
SELECT * FROM pgaadauth_create_principal_with_oid('<MAINTENANCE_MI_NAME>', '<MAINTENANCE_MI_OBJECT_ID>', 'service', false, false);
SELECT * FROM pgaadauth_create_principal_with_oid('<POSITIONS_READ_MI_NAME>', '<POSITIONS_READ_MI_OBJECT_ID>', 'service', false, false);
SELECT * FROM pgaadauth_create_principal_with_oid('<INSTRUMENT_TIMELINE_READ_MI_NAME>', '<INSTRUMENT_TIMELINE_READ_MI_OBJECT_ID>', 'service', false, false);
GRANT CONNECT ON DATABASE "<DATABASE>" TO "<MIGRATION_APP_NAME>", "<ENGINE_MI_NAME>", "<MAINTENANCE_MI_NAME>", "<POSITIONS_READ_MI_NAME>", "<INSTRUMENT_TIMELINE_READ_MI_NAME>";
COMMIT;

\connect <DATABASE>
BEGIN;
-- Run reviewed migrations as MIGRATION_APP_NAME so it owns every table,
-- sequence and function it creates.  CREATE is required for append-only DDL.
ALTER SCHEMA public OWNER TO "<MIGRATION_APP_NAME>";
GRANT USAGE, CREATE ON SCHEMA public TO "<MIGRATION_APP_NAME>";
GRANT USAGE ON SCHEMA public TO "<ENGINE_MI_NAME>", "<MAINTENANCE_MI_NAME>", "<POSITIONS_READ_MI_NAME>", "<INSTRUMENT_TIMELINE_READ_MI_NAME>";
GRANT SELECT, INSERT, UPDATE ON TABLE order_attempts, filled_orders, sync_watermarks, instrument_protection, announcement_receipts, daily_limit_cache TO "<ENGINE_MI_NAME>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "<ENGINE_MI_NAME>";
GRANT SELECT ON TABLE order_attempts, filled_orders, sync_watermarks TO "<MAINTENANCE_MI_NAME>";
GRANT SELECT ON TABLE filled_orders TO "<POSITIONS_READ_MI_NAME>";
GRANT SELECT ON TABLE order_attempts, filled_orders, instrument_protection, sync_watermarks TO "<INSTRUMENT_TIMELINE_READ_MI_NAME>";
-- Retention is a fixed SECURITY DEFINER function owned by the migration role;
-- Maintenance gets EXECUTE only, never general DELETE or order creation.
GRANT EXECUTE ON FUNCTION p4_retain_terminal_attempts(timestamptz, integer) TO "<MAINTENANCE_MI_NAME>";
COMMIT;

-- If an administrator applied the initial migrations before the dedicated
-- migration principal existed, transfer each existing table, sequence and
-- function to MIGRATION_APP_NAME before enabling the GitHub workflow.  The
-- workflow must be able to ALTER existing objects as well as create new ones.
-- If a same-named ordinary role already exists, connect to `postgres` and use
-- pgaadauth_update_principal_with_oid instead of creating it again.

-- Explicitly prohibited: ALTER ROLE ... SUPERUSER; making either runtime
-- identity a schema/object owner; GRANT DELETE ON ALL TABLES; GRANT INSERT ON
-- order_attempts TO maintenance; GRANT INSERT/UPDATE/DELETE or retention
-- EXECUTE to positions-read.
