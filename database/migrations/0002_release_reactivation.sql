CREATE OR REPLACE FUNCTION logiplan.activate_data_release(
  p_data_release_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logiplan
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('logiplan-data-release-activation-v1', 0)
  );

  IF EXISTS (
    SELECT 1
    FROM logiplan.active_data_release AS a
    JOIN logiplan.data_release AS r USING (data_release_id)
    WHERE a.singleton
      AND a.data_release_id = p_data_release_id
      AND r.status = 'ACTIVE'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM logiplan.data_release
    WHERE data_release_id = p_data_release_id
      AND status IN ('VALIDATED', 'RETIRED')
  ) THEN
    RAISE EXCEPTION '只有已校验或已退役发布才能激活：%', p_data_release_id;
  END IF;

  UPDATE logiplan.data_release
  SET status = 'RETIRED'
  WHERE data_release_id = (
    SELECT data_release_id
    FROM logiplan.active_data_release
    WHERE singleton
  )
    AND status = 'ACTIVE';

  UPDATE logiplan.data_release
  SET status = 'ACTIVE',
      activated_at = clock_timestamp()
  WHERE data_release_id = p_data_release_id;

  INSERT INTO logiplan.active_data_release (singleton, data_release_id, activated_at)
  VALUES (true, p_data_release_id, clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE
    SET data_release_id = EXCLUDED.data_release_id,
        activated_at = EXCLUDED.activated_at;
END;
$$;

REVOKE ALL ON FUNCTION logiplan.activate_data_release(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logiplan.activate_data_release(text) TO data_publisher;
