#!/usr/bin/env bash
set -Eeuo pipefail

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=schema_migrator_password="$LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD" \
  --set=data_publisher_password="$LOGIPLAN_DATA_PUBLISHER_PASSWORD" \
  --set=app_reader_password="$LOGIPLAN_APP_READER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE schema_migrator LOGIN PASSWORD %L', :'schema_migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'schema_migrator')
\gexec

SELECT format('CREATE ROLE data_publisher LOGIN PASSWORD %L', :'data_publisher_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'data_publisher')
\gexec

SELECT format('CREATE ROLE app_reader LOGIN PASSWORD %L', :'app_reader_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_reader')
\gexec

ALTER ROLE schema_migrator PASSWORD :'schema_migrator_password';
ALTER ROLE data_publisher PASSWORD :'data_publisher_password';
ALTER ROLE app_reader PASSWORD :'app_reader_password';

GRANT CONNECT ON DATABASE logiplan TO schema_migrator, data_publisher, app_reader;
GRANT CREATE ON DATABASE logiplan TO schema_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO schema_migrator;
SQL
