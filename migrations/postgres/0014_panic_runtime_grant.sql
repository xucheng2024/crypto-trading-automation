-- The migration identity owns new tables; the Engine identity needs only the
-- privileges used to keep the panic strategy's daily state. Local databases
-- may not provision an Engine role, so zero matches are valid.
DO $$
DECLARE
  engine_role text;
BEGIN
  FOR engine_role IN
    SELECT rolname FROM pg_roles
    WHERE rolname LIKE '%-engine' AND has_table_privilege(rolname, 'filled_orders', 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE panic_daily_instruments TO %I', engine_role);
  END LOOP;
END
$$;
