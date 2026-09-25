-- Query snapshots are separate from published business facts and AI session answers.
CREATE TABLE logiplan.evidence_snapshot (
  evidence_snapshot_id text PRIMARY KEY,
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION logiplan.reject_evidence_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Evidence snapshots are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER evidence_snapshot_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON logiplan.evidence_snapshot
FOR EACH STATEMENT EXECUTE FUNCTION logiplan.reject_evidence_snapshot_mutation();

-- Only the trusted query service supplies a validated result. The caller cannot
-- choose a release or snapshot ID, overwrite a snapshot, or write business facts.
CREATE FUNCTION logiplan.persist_evidence_snapshot(query_result jsonb)
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
  SELECT data_release_id INTO STRICT release_id FROM logiplan.active_release;
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
REVOKE ALL ON FUNCTION logiplan.reject_evidence_snapshot_mutation() FROM PUBLIC, data_publisher, app_reader;
REVOKE ALL ON FUNCTION logiplan.persist_evidence_snapshot(jsonb) FROM PUBLIC, app_reader;
GRANT EXECUTE ON FUNCTION logiplan.persist_evidence_snapshot(jsonb) TO data_publisher;
