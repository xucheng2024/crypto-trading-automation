-- Maintenance receives EXECUTE on this fixed, bounded operation instead of
-- general DELETE. The migration owner remains the SECURITY DEFINER owner.
CREATE OR REPLACE FUNCTION p4_retain_terminal_attempts(p_before timestamptz, p_limit integer)
RETURNS TABLE(id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_before IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'invalid retention arguments';
  END IF;
  RETURN QUERY
    DELETE FROM public.order_attempts AS attempts
    WHERE attempts.id IN (
      SELECT victims.id FROM public.order_attempts AS victims
      WHERE victims.state IN ('NOT_CREATED','SETTLED') AND victims.updated_at < p_before
      ORDER BY victims.id LIMIT p_limit
    )
    RETURNING attempts.id;
END;
$$;
REVOKE ALL ON FUNCTION p4_retain_terminal_attempts(timestamptz, integer) FROM PUBLIC;
