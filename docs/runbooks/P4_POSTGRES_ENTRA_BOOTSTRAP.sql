-- REVIEW-ONLY TEMPLATE. Azure administrator generates/reviews this; do not run
-- it from the Engine or Maintenance containers. Replace only placeholders.
-- Migration identity is separate from both runtime identities.
BEGIN;
SELECT * FROM pgaadauth_create_principal('<ENGINE_MI_NAME>', false, false);
SELECT * FROM pgaadauth_create_principal('<MAINTENANCE_MI_NAME>', false, false);
GRANT CONNECT ON DATABASE "<DATABASE>" TO "<ENGINE_MI_NAME>", "<MAINTENANCE_MI_NAME>";
GRANT USAGE ON SCHEMA public TO "<ENGINE_MI_NAME>", "<MAINTENANCE_MI_NAME>";
GRANT SELECT, INSERT, UPDATE ON TABLE order_attempts, filled_orders, sync_watermarks, instrument_protection, announcement_receipts, daily_limit_cache TO "<ENGINE_MI_NAME>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "<ENGINE_MI_NAME>";
GRANT SELECT ON TABLE order_attempts, filled_orders, sync_watermarks TO "<MAINTENANCE_MI_NAME>";
-- Retention is a fixed SECURITY DEFINER function owned by the migration role;
-- Maintenance gets EXECUTE only, never general DELETE or order creation.
GRANT EXECUTE ON FUNCTION p4_retain_terminal_attempts(timestamptz, integer) TO "<MAINTENANCE_MI_NAME>";
COMMIT;

-- Explicitly prohibited: ALTER ROLE ... SUPERUSER; ALTER SCHEMA public OWNER;
-- GRANT DELETE ON ALL TABLES; GRANT INSERT ON order_attempts TO maintenance.
