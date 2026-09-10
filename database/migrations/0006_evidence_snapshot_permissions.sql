-- Keep snapshot persistence publisher-only without requiring publisher access to
-- the security-barrier active_release view.
CREATE OR REPLACE FUNCTION logiplan.persist_evidence_snapshot(query_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  release_id text;
  snapshot_id text := 'ES-' || gen_random_uuid()::text;
  saved_result jsonb;
BEGIN
  IF query_result IS NULL
     OR jsonb_typeof(query_result) IS DISTINCT FROM 'object'
     OR query_result->>'contract_version' IS DISTINCT FROM 'V1.1'
     OR jsonb_typeof(query_result->'query_intent') IS DISTINCT FROM 'object'
     OR jsonb_typeof(query_result->'query_intent'->'scope') IS DISTINCT FROM 'object'
     OR jsonb_typeof(query_result->'evidence') IS DISTINCT FROM 'array'
     OR NOT (query_result ?& ARRAY['result_id', 'payload', 'generated_at', 'data_as_of', '_data_release_id'])
     OR octet_length(query_result::text) > 8388608 THEN
    RAISE EXCEPTION 'Invalid query snapshot' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(query_result->'evidence') = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(query_result->'evidence') e
       WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
          OR COALESCE(length(e->>'evidence_id'), 0) NOT BETWEEN 1 AND 240
          OR NOT (e ?& ARRAY['value', 'versions', 'source_result_id', 'snapshot_generated_at'])
          OR e ?| ARRAY['evidence_snapshot_id', 'data_release_id']
     ) THEN
    RAISE EXCEPTION 'Invalid snapshot evidence' USING ERRCODE = '22023';
  END IF;
  SELECT a.data_release_id INTO STRICT release_id
  FROM logiplan.active_data_release AS a
  JOIN logiplan.data_release AS r USING (data_release_id)
  WHERE a.singleton AND r.status = 'ACTIVE';
  IF query_result->>'_data_release_id' IS DISTINCT FROM release_id THEN
    RAISE EXCEPTION 'Snapshot release changed during query' USING ERRCODE = '40001';
  END IF;
  saved_result := jsonb_set(query_result - '_data_release_id', '{evidence}', (
    SELECT jsonb_agg(e || jsonb_build_object(
      'evidence_snapshot_id', snapshot_id, 'data_release_id', release_id
    ) ORDER BY ordinal)
    FROM jsonb_array_elements(query_result->'evidence') WITH ORDINALITY AS items(e, ordinal)
  ));
  INSERT INTO logiplan.evidence_snapshot (evidence_snapshot_id, data_release_id, result)
  VALUES (snapshot_id, release_id, saved_result);
  RETURN saved_result;
END;
$$;

REVOKE ALL ON logiplan.evidence_snapshot FROM PUBLIC, data_publisher, app_reader;
GRANT SELECT ON logiplan.evidence_snapshot TO app_reader;
REVOKE ALL ON FUNCTION logiplan.persist_evidence_snapshot(jsonb) FROM PUBLIC, app_reader;
GRANT EXECUTE ON FUNCTION logiplan.persist_evidence_snapshot(jsonb) TO data_publisher;
