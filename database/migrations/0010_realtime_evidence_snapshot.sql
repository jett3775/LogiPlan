-- Trusted query-service append-only entry. The publisher's idempotent function
-- remains unchanged. This validates structure/binding, not Decimal mathematics.
CREATE FUNCTION logiplan.persist_query_evidence_snapshot(query_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  release_id text;
  snapshot_id text := 'ES-' || pg_catalog.gen_random_uuid()::text;
  saved_result jsonb;
  item jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'Realtime snapshot requires REPEATABLE READ' USING ERRCODE = '25001';
  END IF;
  IF query_result IS NULL
     OR jsonb_typeof(query_result) IS DISTINCT FROM 'object'
     OR octet_length(query_result::text) > 8388608 THEN
    RAISE EXCEPTION 'Invalid query snapshot' USING ERRCODE = '22023';
  END IF;
  IF NOT (query_result ?& ARRAY['contract_version','result_id','query_intent','scope_label',
       'data_as_of','generated_at','reporting_currency','precision','payload','evidence','warnings','_data_release_id'])
     OR (query_result - ARRAY['contract_version','result_id','query_intent','scope_label',
       'data_as_of','generated_at','reporting_currency','precision','payload','evidence','warnings','_data_release_id']) <> '{}'::jsonb
     OR query_result->>'contract_version' IS DISTINCT FROM 'V1.1'
     OR jsonb_typeof(query_result->'result_id') IS DISTINCT FROM 'string'
     OR COALESCE(length(query_result->>'result_id'), 0) NOT BETWEEN 1 AND 240
     OR jsonb_typeof(query_result->'_data_release_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'scope_label') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'generated_at') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'data_as_of') IS DISTINCT FROM 'string'
     OR query_result->>'reporting_currency' IS DISTINCT FROM 'CNY'
     OR query_result->'precision' IS DISTINCT FROM '{"calculation":"HIGH_PRECISION_DECIMAL","report_places":4,"display_places":2}'::jsonb
     OR jsonb_typeof(query_result->'query_intent') IS DISTINCT FROM 'object'
     OR query_result->'query_intent'->>'contract_version' IS DISTINCT FROM 'V1.1'
     OR jsonb_typeof(query_result->'query_intent'->'scope') IS DISTINCT FROM 'object'
     OR jsonb_typeof(query_result->'payload') IS DISTINCT FROM 'object'
     OR jsonb_typeof(query_result->'evidence') IS DISTINCT FROM 'array'
     OR jsonb_typeof(query_result->'warnings') IS DISTINCT FROM 'array'
     OR jsonb_path_exists(query_result, '$.**.evidence_snapshot_id')
     OR jsonb_path_exists(query_result, '$.**.data_release_id') THEN
    RAISE EXCEPTION 'Invalid query snapshot structure' USING ERRCODE = '22023';
  END IF;
  IF NOT ((query_result->'query_intent') ?& ARRAY['contract_version','question_type','scope','metrics','group_by','output_locale','context_sources'])
     OR jsonb_typeof(query_result->'query_intent'->'question_type') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'query_intent'->'metrics') IS DISTINCT FROM 'array'
     OR jsonb_typeof(query_result->'query_intent'->'group_by') IS DISTINCT FROM 'array'
     OR jsonb_typeof(query_result->'query_intent'->'context_sources') IS DISTINCT FROM 'array'
     OR query_result->'query_intent'->>'output_locale' IS DISTINCT FROM 'zh-CN'
     OR NOT ((query_result->'query_intent'->'scope') ?& ARRAY['period','comparison','budget_version_id','calculation_version'])
     OR jsonb_typeof(query_result->'query_intent'->'scope'->'period') IS DISTINCT FROM 'object'
     OR jsonb_typeof(query_result->'query_intent'->'scope'->'comparison') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'query_intent'->'scope'->'budget_version_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(query_result->'query_intent'->'scope'->'calculation_version') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Invalid snapshot query structure' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(query_result->'evidence') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR NOT (item ?& ARRAY['evidence_id','metric','value','unit','period','comparison',
         'filters','group_by','versions','calculation_method','source_result_id','snapshot_generated_at','source_refs'])
       OR jsonb_typeof(item->'evidence_id') IS DISTINCT FROM 'string'
       OR COALESCE(length(item->>'evidence_id'), 0) NOT BETWEEN 1 AND 240
       OR item->>'evidence_id' <> btrim(item->>'evidence_id')
       OR jsonb_typeof(item->'metric') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'unit') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'comparison') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'calculation_method') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'value') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'period') IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'filters') IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'group_by') IS DISTINCT FROM 'array'
       OR jsonb_typeof(item->'versions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'source_result_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'snapshot_generated_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'source_refs') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid snapshot evidence' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(query_result->'warnings') AS w
     WHERE jsonb_typeof(w) IS DISTINCT FROM 'object'
        OR jsonb_typeof(w->'code') IS DISTINCT FROM 'string'
        OR jsonb_typeof(w->'message') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'Invalid snapshot warnings' USING ERRCODE = '22023';
  END IF;
  -- Same transaction view as the app_reader fact reads; concurrent activation
  -- cannot relabel an A result as B. No lock or write to business tables is needed.
  SELECT a.data_release_id INTO STRICT release_id
  FROM logiplan.active_data_release AS a
  JOIN logiplan.data_release AS r USING (data_release_id)
  WHERE a.singleton AND r.status = 'ACTIVE';
  IF query_result->>'_data_release_id' IS DISTINCT FROM release_id THEN
    RAISE EXCEPTION 'Snapshot release binding mismatch' USING ERRCODE = '40001';
  END IF;
  saved_result := jsonb_set(query_result - '_data_release_id', '{evidence}', (
    SELECT COALESCE(jsonb_agg(e || jsonb_build_object(
      'evidence_snapshot_id', snapshot_id, 'data_release_id', release_id
    ) ORDER BY ordinal), '[]'::jsonb)
    FROM jsonb_array_elements(query_result->'evidence') WITH ORDINALITY AS items(e, ordinal)
  ));
  IF query_result->'query_intent'->>'question_type' = 'EVIDENCE_LOOKUP' THEN
    IF jsonb_array_length(query_result->'evidence') <> 1
       OR query_result->'payload' IS DISTINCT FROM jsonb_build_object('evidence', query_result->'evidence'->0)
       OR query_result->'query_intent'->>'evidence_id' IS DISTINCT FROM query_result->'evidence'->0->>'evidence_id' THEN
      RAISE EXCEPTION 'Invalid legacy lookup evidence' USING ERRCODE = '22023';
    END IF;
    saved_result := jsonb_set(saved_result, '{payload,evidence}', saved_result->'evidence'->0);
  END IF;
  INSERT INTO logiplan.evidence_snapshot (evidence_snapshot_id, data_release_id, result)
  VALUES (snapshot_id, release_id, saved_result);
  RETURN saved_result;
END;
$$;

REVOKE ALL ON FUNCTION logiplan.persist_query_evidence_snapshot(jsonb) FROM PUBLIC, data_publisher, app_reader;
GRANT EXECUTE ON FUNCTION logiplan.persist_query_evidence_snapshot(jsonb) TO app_reader;
