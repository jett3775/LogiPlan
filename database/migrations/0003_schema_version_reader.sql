CREATE FUNCTION logiplan.current_schema_version()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT max(version) FROM public._schema_migrations;
$$;

REVOKE ALL ON FUNCTION logiplan.current_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logiplan.current_schema_version() TO data_publisher, app_reader;
