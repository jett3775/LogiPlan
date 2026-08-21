CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE SCHEMA logiplan AUTHORIZATION schema_migrator;

CREATE TABLE logiplan.data_release (
  data_release_id text PRIMARY KEY,
  release_version text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('CANDIDATE', 'VALIDATED', 'ACTIVE', 'RETIRED', 'FAILED')),
  input_checksum_sha256 char(64) NOT NULL CHECK (input_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  database_schema_version text NOT NULL,
  calculation_version text NOT NULL,
  generator_version text NOT NULL,
  source_description text NOT NULL,
  validation_summary jsonb,
  generated_at timestamptz NOT NULL,
  validated_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status NOT IN ('VALIDATED', 'ACTIVE', 'RETIRED') OR validated_at IS NOT NULL),
  CHECK (status NOT IN ('ACTIVE', 'RETIRED') OR activated_at IS NOT NULL)
);

CREATE UNIQUE INDEX data_release_single_active_status
  ON logiplan.data_release (status)
  WHERE status = 'ACTIVE';

CREATE TABLE logiplan.active_data_release (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  data_release_id text NOT NULL UNIQUE REFERENCES logiplan.data_release (data_release_id),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE logiplan.dim_destination_country (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  destination_country_id text NOT NULL,
  destination_country_name_zh text NOT NULL,
  active_from date NOT NULL,
  active_to date,
  PRIMARY KEY (data_release_id, destination_country_id),
  CHECK (active_to IS NULL OR active_to >= active_from)
);

CREATE TABLE logiplan.dim_fulfillment_center (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  fulfillment_center_id text NOT NULL,
  fulfillment_center_name_zh text NOT NULL,
  location_country_id text NOT NULL,
  iana_timezone text NOT NULL,
  active_from date NOT NULL,
  active_to date,
  PRIMARY KEY (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, location_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  CHECK (active_to IS NULL OR active_to >= active_from)
);

CREATE TABLE logiplan.dim_carrier (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  carrier_id text NOT NULL,
  carrier_name text NOT NULL,
  demo_role_note text NOT NULL,
  is_demo_entity boolean NOT NULL DEFAULT true CHECK (is_demo_entity),
  PRIMARY KEY (data_release_id, carrier_id)
);

CREATE TABLE logiplan.dim_transport_mode (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  transport_mode_id text NOT NULL CHECK (transport_mode_id IN ('AIR', 'ROAD')),
  transport_mode_name_zh text NOT NULL,
  PRIMARY KEY (data_release_id, transport_mode_id)
);

CREATE TABLE logiplan.fulfillment_route (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  route_id text NOT NULL,
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  carrier_id text NOT NULL,
  transport_mode_id text NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  PRIMARY KEY (data_release_id, route_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, carrier_id)
    REFERENCES logiplan.dim_carrier (data_release_id, carrier_id),
  FOREIGN KEY (data_release_id, transport_mode_id)
    REFERENCES logiplan.dim_transport_mode (data_release_id, transport_mode_id),
  UNIQUE (
    data_release_id,
    destination_country_id,
    fulfillment_center_id,
    carrier_id,
    transport_mode_id,
    valid_from
  ),
  EXCLUDE USING gist (
    data_release_id WITH =,
    destination_country_id WITH =,
    fulfillment_center_id WITH =,
    carrier_id WITH =,
    transport_mode_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE logiplan.business_event_note (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  event_note_id text NOT NULL,
  note_type text NOT NULL CHECK (note_type IN ('BUSINESS_CONTEXT', 'MANAGEMENT_ACTION')),
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text,
  note_text text NOT NULL,
  source_type text NOT NULL CHECK (source_type = 'DEMO_PLANNING_ASSUMPTION'),
  version_id text NOT NULL,
  PRIMARY KEY (data_release_id, event_note_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id)
);

CREATE TABLE logiplan.fx_rate_version (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  fx_version_id text NOT NULL,
  version_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  source_note text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (data_release_id, fx_version_id)
);

CREATE TABLE logiplan.fx_rate (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  fx_rate_id text NOT NULL,
  fx_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  cny_per_currency_unit numeric(20,6) NOT NULL CHECK (cny_per_currency_unit > 0),
  rate_type text NOT NULL
    CHECK (rate_type IN ('BUDGET_ANNUAL', 'ACTUAL_MONTHLY_AVERAGE', 'FORECAST_PLANNING')),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, fx_rate_id),
  FOREIGN KEY (data_release_id, fx_version_id)
    REFERENCES logiplan.fx_rate_version (data_release_id, fx_version_id),
  UNIQUE (data_release_id, fx_version_id, month_id, currency_code),
  CHECK (currency_code <> 'CNY' OR cny_per_currency_unit = 1)
);

CREATE TABLE logiplan.price_version (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  price_version_id text NOT NULL,
  version_name text NOT NULL,
  version_type text NOT NULL CHECK (version_type IN ('BUDGET', 'ACTUAL', 'FORECAST')),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  valid_from date NOT NULL,
  valid_to date,
  source_note text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (data_release_id, price_version_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE logiplan.scenario_version (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  scenario_type text NOT NULL CHECK (scenario_type IN ('BUDGET', 'ACTUAL', 'FORECAST')),
  version_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  base_budget_version_id text,
  price_version_id text NOT NULL,
  fx_version_id text NOT NULL,
  latest_closed_month date
    CHECK (latest_closed_month IS NULL OR date_trunc('month', latest_closed_month)::date = latest_closed_month),
  published_at timestamptz,
  change_reason text,
  calculation_version text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, base_budget_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, fx_version_id)
    REFERENCES logiplan.fx_rate_version (data_release_id, fx_version_id)
);

CREATE TABLE logiplan.transport_price (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  transport_price_id text NOT NULL,
  price_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_base_rate_per_kg numeric(20,4) NOT NULL CHECK (effective_base_rate_per_kg >= 0),
  fuel_charge_basis text NOT NULL CHECK (
    fuel_charge_basis IN ('PERCENTAGE_OF_BASE_FREIGHT', 'PER_CHARGEABLE_KG', 'PER_PACKAGE')
  ),
  fuel_rate_or_unit_price numeric(20,6) NOT NULL CHECK (fuel_rate_or_unit_price >= 0),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, transport_price_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  UNIQUE (data_release_id, price_version_id, month_id, route_id)
);

CREATE TABLE logiplan.frontline_variable_labor_price (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  labor_price_id text NOT NULL,
  price_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  fulfillment_center_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  variable_labor_price_per_order numeric(20,4) NOT NULL CHECK (variable_labor_price_per_order >= 0),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, labor_price_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  UNIQUE (data_release_id, price_version_id, month_id, fulfillment_center_id)
);

CREATE TABLE logiplan.packaging_price (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  packaging_price_id text NOT NULL,
  price_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  fulfillment_center_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  packaging_price_per_package numeric(20,4) NOT NULL CHECK (packaging_price_per_package >= 0),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, packaging_price_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  UNIQUE (data_release_id, price_version_id, month_id, fulfillment_center_id)
);

CREATE TABLE logiplan.return_logistics_price (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  return_price_id text NOT NULL,
  price_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_return_price_per_package numeric(20,4) NOT NULL
    CHECK (effective_return_price_per_package >= 0),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, return_price_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  UNIQUE (
    data_release_id,
    price_version_id,
    month_id,
    destination_country_id,
    fulfillment_center_id
  )
);

CREATE TABLE logiplan.billable_exception_price (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  exception_price_id text NOT NULL,
  price_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  average_price_per_billable_event numeric(20,4) NOT NULL
    CHECK (average_price_per_billable_event >= 0),
  source_note text NOT NULL,
  PRIMARY KEY (data_release_id, exception_price_id),
  FOREIGN KEY (data_release_id, price_version_id)
    REFERENCES logiplan.price_version (data_release_id, price_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  UNIQUE (data_release_id, price_version_id, month_id, route_id)
);

CREATE TABLE logiplan.budget_country_month (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  order_qty numeric(20,4) NOT NULL CHECK (order_qty >= 0),
  gmv_original_amount numeric(20,4) NOT NULL CHECK (gmv_original_amount >= 0),
  gmv_currency_code char(3) NOT NULL CHECK (gmv_currency_code ~ '^[A-Z]{3}$'),
  gmv_fx_rate_id text NOT NULL,
  assumption_note text NOT NULL,
  source_type text NOT NULL DEFAULT 'DEMO_PLANNING_ASSUMPTION'
    CHECK (source_type = 'DEMO_PLANNING_ASSUMPTION'),
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, gmv_fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id)
);

CREATE TABLE logiplan.budget_warehouse_allocation (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  warehouse_order_share numeric(12,6) NOT NULL CHECK (warehouse_order_share BETWEEN 0 AND 1),
  assumption_note text NOT NULL,
  PRIMARY KEY (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  ),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id)
);

CREATE TABLE logiplan.budget_route_allocation (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  route_package_share_within_warehouse numeric(12,6) NOT NULL
    CHECK (route_package_share_within_warehouse BETWEEN 0 AND 1),
  average_chargeable_weight_per_package_kg numeric(20,4) NOT NULL
    CHECK (average_chargeable_weight_per_package_kg >= 0),
  assumption_note text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.budget_packages_per_order (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  average_packages_per_order numeric(20,6) NOT NULL CHECK (average_packages_per_order >= 0),
  assumption_note text NOT NULL,
  PRIMARY KEY (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  ),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id)
);

CREATE TABLE logiplan.budget_return_rate (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  return_rate numeric(12,6) NOT NULL CHECK (return_rate BETWEEN 0 AND 1),
  assumption_note text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id)
);

CREATE TABLE logiplan.budget_billable_exception_rate (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  billable_events_per_package numeric(12,6) NOT NULL CHECK (billable_events_per_package >= 0),
  assumption_note text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.budget_route_service_standard (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  planned_on_time_rate numeric(12,6) NOT NULL CHECK (planned_on_time_rate BETWEEN 0 AND 1),
  promised_service_days numeric(20,4) NOT NULL CHECK (promised_service_days >= 0),
  assumption_note text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.budget_fixed_cost (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  budget_fixed_cost_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  cost_scope_type text NOT NULL CHECK (cost_scope_type IN ('FULFILLMENT_CENTER', 'SHARED')),
  fulfillment_center_id text,
  fixed_cost_category text NOT NULL CHECK (
    fixed_cost_category IN (
      'WAREHOUSE_RENT', 'FRONTLINE_BASE_LABOR', 'WAREHOUSE_MANAGEMENT_LABOR', 'SYSTEM_COST'
    )
  ),
  original_amount numeric(20,4) NOT NULL CHECK (original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  assumption_note text NOT NULL,
  PRIMARY KEY (data_release_id, budget_fixed_cost_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, cost_scope_type,
    fulfillment_center_id, fixed_cost_category
  ),
  CHECK (
    (cost_scope_type = 'FULFILLMENT_CENTER' AND fulfillment_center_id IS NOT NULL)
    OR (cost_scope_type = 'SHARED' AND fulfillment_center_id IS NULL)
  )
);

CREATE TABLE logiplan.actual_country_warehouse_fulfillment (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  order_qty numeric(20,4) NOT NULL CHECK (order_qty >= 0),
  carrier_received_month date NOT NULL
    CHECK (date_trunc('month', carrier_received_month)::date = carrier_received_month),
  source_record_id text NOT NULL,
  PRIMARY KEY (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  ),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id)
);

CREATE TABLE logiplan.actual_route_operation (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  package_qty numeric(20,4) NOT NULL CHECK (package_qty >= 0),
  chargeable_weight_kg numeric(20,4) NOT NULL CHECK (chargeable_weight_kg >= 0),
  actual_weight_kg numeric(20,4) NOT NULL CHECK (actual_weight_kg >= 0),
  billable_exception_event_qty numeric(20,4) NOT NULL
    CHECK (billable_exception_event_qty >= 0),
  source_record_id text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.actual_return_operation (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  returned_order_qty numeric(20,4) NOT NULL CHECK (returned_order_qty >= 0),
  source_record_id text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id)
);

CREATE TABLE logiplan.actual_gmv (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  original_amount numeric(20,4) NOT NULL CHECK (original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  cny_amount numeric(20,4) NOT NULL CHECK (cny_amount >= 0),
  source_record_id text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id)
);

CREATE TABLE logiplan.actual_route_service (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  shipment_month date NOT NULL CHECK (date_trunc('month', shipment_month)::date = shipment_month),
  route_id text NOT NULL,
  cohort_package_qty numeric(20,4) NOT NULL CHECK (cohort_package_qty >= 0),
  due_package_qty numeric(20,4) NOT NULL CHECK (due_package_qty BETWEEN 0 AND cohort_package_qty),
  on_time_delivered_package_qty numeric(20,4) NOT NULL
    CHECK (on_time_delivered_package_qty BETWEEN 0 AND due_package_qty),
  source_record_id text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, shipment_month, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.actual_transport_cost (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  actual_transport_cost_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  cost_category text NOT NULL CHECK (
    cost_category IN ('BASE_FREIGHT', 'FUEL_SURCHARGE', 'BILLABLE_EXCEPTION')
  ),
  authoritative_original_amount numeric(20,4) NOT NULL CHECK (authoritative_original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  authoritative_cny_amount numeric(20,4) NOT NULL CHECK (authoritative_cny_amount >= 0),
  amount_source text NOT NULL CHECK (amount_source IN ('INVOICE', 'ACCRUAL')),
  source_record_id text NOT NULL,
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('MATCHED', 'UNEXPLAINED')),
  PRIMARY KEY (data_release_id, actual_transport_cost_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (data_release_id, scenario_version_id, month_id, route_id, cost_category)
);

CREATE TABLE logiplan.actual_fulfillment_variable_cost (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  actual_variable_cost_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  fulfillment_center_id text NOT NULL,
  cost_category text NOT NULL CHECK (cost_category IN ('FRONTLINE_VARIABLE_LABOR', 'PACKAGING')),
  authoritative_original_amount numeric(20,4) NOT NULL CHECK (authoritative_original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  authoritative_cny_amount numeric(20,4) NOT NULL CHECK (authoritative_cny_amount >= 0),
  amount_source text NOT NULL CHECK (amount_source IN ('INVOICE', 'ACCRUAL')),
  source_record_id text NOT NULL,
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('MATCHED', 'UNEXPLAINED')),
  PRIMARY KEY (data_release_id, actual_variable_cost_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, fulfillment_center_id, cost_category
  )
);

CREATE TABLE logiplan.actual_return_cost (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  actual_return_cost_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  authoritative_original_amount numeric(20,4) NOT NULL CHECK (authoritative_original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  authoritative_cny_amount numeric(20,4) NOT NULL CHECK (authoritative_cny_amount >= 0),
  amount_source text NOT NULL CHECK (amount_source IN ('INVOICE', 'ACCRUAL')),
  source_record_id text NOT NULL,
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('MATCHED', 'UNEXPLAINED')),
  PRIMARY KEY (data_release_id, actual_return_cost_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  )
);

CREATE TABLE logiplan.actual_fixed_cost (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  actual_fixed_cost_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  cost_scope_type text NOT NULL CHECK (cost_scope_type IN ('FULFILLMENT_CENTER', 'SHARED')),
  fulfillment_center_id text,
  fixed_cost_category text NOT NULL CHECK (
    fixed_cost_category IN (
      'WAREHOUSE_RENT', 'FRONTLINE_BASE_LABOR', 'WAREHOUSE_MANAGEMENT_LABOR', 'SYSTEM_COST'
    )
  ),
  authoritative_original_amount numeric(20,4) NOT NULL CHECK (authoritative_original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  authoritative_cny_amount numeric(20,4) NOT NULL CHECK (authoritative_cny_amount >= 0),
  amount_source text NOT NULL CHECK (amount_source IN ('INVOICE', 'ACCRUAL')),
  source_record_id text NOT NULL,
  reconciliation_status text NOT NULL CHECK (reconciliation_status IN ('MATCHED', 'UNEXPLAINED')),
  PRIMARY KEY (data_release_id, actual_fixed_cost_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, cost_scope_type,
    fulfillment_center_id, fixed_cost_category
  ),
  CHECK (
    (cost_scope_type = 'FULFILLMENT_CENTER' AND fulfillment_center_id IS NOT NULL)
    OR (cost_scope_type = 'SHARED' AND fulfillment_center_id IS NULL)
  )
);

CREATE TABLE logiplan.forecast_country_order_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  target_order_qty numeric(20,4),
  relative_budget_adjustment numeric(12,6),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  CHECK ((target_order_qty IS NULL) <> (relative_budget_adjustment IS NULL)),
  CHECK (target_order_qty IS NULL OR target_order_qty >= 0)
);

CREATE TABLE logiplan.forecast_warehouse_share_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  warehouse_order_share numeric(12,6) NOT NULL CHECK (warehouse_order_share BETWEEN 0 AND 1),
  override_reason text NOT NULL,
  PRIMARY KEY (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  ),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id)
);

CREATE TABLE logiplan.forecast_route_share_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  route_package_share_within_warehouse numeric(12,6) NOT NULL
    CHECK (route_package_share_within_warehouse BETWEEN 0 AND 1),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.forecast_weight_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  average_chargeable_weight_per_package_kg numeric(20,4) NOT NULL
    CHECK (average_chargeable_weight_per_package_kg >= 0),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.forecast_packages_per_order_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  fulfillment_center_id text NOT NULL,
  average_packages_per_order numeric(20,6) NOT NULL CHECK (average_packages_per_order >= 0),
  override_reason text NOT NULL,
  PRIMARY KEY (
    data_release_id, scenario_version_id, month_id, destination_country_id, fulfillment_center_id
  ),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id)
);

CREATE TABLE logiplan.forecast_return_rate_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  return_rate numeric(12,6) NOT NULL CHECK (return_rate BETWEEN 0 AND 1),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id)
);

CREATE TABLE logiplan.forecast_exception_rate_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  billable_events_per_package numeric(12,6) NOT NULL CHECK (billable_events_per_package >= 0),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id)
);

CREATE TABLE logiplan.forecast_service_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  planned_on_time_rate numeric(12,6) CHECK (planned_on_time_rate BETWEEN 0 AND 1),
  promised_service_days numeric(20,4) CHECK (promised_service_days >= 0),
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, route_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  CHECK (planned_on_time_rate IS NOT NULL OR promised_service_days IS NOT NULL)
);

CREATE TABLE logiplan.forecast_gmv_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  original_amount numeric(20,4) NOT NULL CHECK (original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id)
);

CREATE TABLE logiplan.forecast_fixed_cost_override (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  forecast_fixed_cost_override_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  cost_scope_type text NOT NULL CHECK (cost_scope_type IN ('FULFILLMENT_CENTER', 'SHARED')),
  fulfillment_center_id text,
  fixed_cost_category text NOT NULL CHECK (
    fixed_cost_category IN (
      'WAREHOUSE_RENT', 'FRONTLINE_BASE_LABOR', 'WAREHOUSE_MANAGEMENT_LABOR', 'SYSTEM_COST'
    )
  ),
  original_amount numeric(20,4) NOT NULL CHECK (original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  override_reason text NOT NULL,
  PRIMARY KEY (data_release_id, forecast_fixed_cost_override_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, cost_scope_type,
    fulfillment_center_id, fixed_cost_category
  ),
  CHECK (
    (cost_scope_type = 'FULFILLMENT_CENTER' AND fulfillment_center_id IS NOT NULL)
    OR (cost_scope_type = 'SHARED' AND fulfillment_center_id IS NULL)
  )
);

CREATE TABLE logiplan.fulfillment_scenario_fact (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  fulfillment_fact_id text NOT NULL,
  scenario_type text NOT NULL CHECK (scenario_type IN ('BUDGET', 'ACTUAL', 'FORECAST')),
  scenario_version_id text NOT NULL,
  calculation_version text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  equivalent_order_qty numeric(20,4) NOT NULL CHECK (equivalent_order_qty >= 0),
  package_qty numeric(20,4) NOT NULL CHECK (package_qty >= 0),
  average_packages_per_order numeric(20,6) NOT NULL CHECK (average_packages_per_order >= 0),
  chargeable_weight_kg numeric(20,4) NOT NULL CHECK (chargeable_weight_kg >= 0),
  average_chargeable_weight_per_package_kg numeric(20,4) NOT NULL
    CHECK (average_chargeable_weight_per_package_kg >= 0),
  actual_weight_kg numeric(20,4) CHECK (actual_weight_kg >= 0),
  return_rate numeric(12,6) NOT NULL CHECK (return_rate BETWEEN 0 AND 1),
  return_package_qty numeric(20,4) NOT NULL CHECK (return_package_qty >= 0),
  billable_events_per_package numeric(12,6) NOT NULL CHECK (billable_events_per_package >= 0),
  billable_exception_event_qty numeric(20,4) NOT NULL
    CHECK (billable_exception_event_qty >= 0),
  on_time_rate numeric(12,6) CHECK (on_time_rate BETWEEN 0 AND 1),
  service_maturity_rate numeric(12,6) CHECK (service_maturity_rate BETWEEN 0 AND 1),
  source_lineage jsonb NOT NULL,
  PRIMARY KEY (data_release_id, fulfillment_fact_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  UNIQUE (data_release_id, scenario_version_id, month_id, route_id)
);

CREATE TABLE logiplan.scenario_cost_component_fact (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  cost_component_fact_id text NOT NULL,
  fulfillment_fact_id text NOT NULL,
  cost_category text NOT NULL CHECK (
    cost_category IN (
      'BASE_FREIGHT', 'FUEL_SURCHARGE', 'BILLABLE_EXCEPTION',
      'FRONTLINE_VARIABLE_LABOR', 'PACKAGING', 'RETURN_LOGISTICS'
    )
  ),
  price_record_id text NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  model_original_amount numeric(50,24) NOT NULL,
  authoritative_original_amount numeric(20,4),
  fx_rate_id text NOT NULL,
  model_cny_amount numeric(50,24) NOT NULL,
  report_cny_amount numeric(20,4) NOT NULL,
  settlement_variance_cny numeric(50,24) NOT NULL,
  amount_source text CHECK (amount_source IN ('INVOICE', 'ACCRUAL')),
  PRIMARY KEY (data_release_id, cost_component_fact_id),
  FOREIGN KEY (data_release_id, fulfillment_fact_id)
    REFERENCES logiplan.fulfillment_scenario_fact (data_release_id, fulfillment_fact_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (data_release_id, fulfillment_fact_id, cost_category)
);

CREATE TABLE logiplan.scenario_gmv_fact (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  destination_country_id text NOT NULL,
  original_amount numeric(20,4) NOT NULL CHECK (original_amount >= 0),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  cny_amount numeric(20,4) NOT NULL CHECK (cny_amount >= 0),
  source_lineage jsonb NOT NULL,
  PRIMARY KEY (data_release_id, scenario_version_id, month_id, destination_country_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id)
);

CREATE TABLE logiplan.fixed_cost_scenario_fact (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  fixed_cost_fact_id text NOT NULL,
  scenario_version_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  cost_scope_type text NOT NULL CHECK (cost_scope_type IN ('FULFILLMENT_CENTER', 'SHARED')),
  fulfillment_center_id text,
  fixed_cost_category text NOT NULL CHECK (
    fixed_cost_category IN (
      'WAREHOUSE_RENT', 'FRONTLINE_BASE_LABOR', 'WAREHOUSE_MANAGEMENT_LABOR', 'SYSTEM_COST'
    )
  ),
  original_amount numeric(20,4) NOT NULL,
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  fx_rate_id text NOT NULL,
  cny_amount numeric(20,4) NOT NULL,
  source_type text NOT NULL,
  source_lineage jsonb NOT NULL,
  PRIMARY KEY (data_release_id, fixed_cost_fact_id),
  FOREIGN KEY (data_release_id, scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, fulfillment_center_id)
    REFERENCES logiplan.dim_fulfillment_center (data_release_id, fulfillment_center_id),
  FOREIGN KEY (data_release_id, fx_rate_id)
    REFERENCES logiplan.fx_rate (data_release_id, fx_rate_id),
  UNIQUE (
    data_release_id, scenario_version_id, month_id, cost_scope_type,
    fulfillment_center_id, fixed_cost_category
  ),
  CHECK (
    (cost_scope_type = 'FULFILLMENT_CENTER' AND fulfillment_center_id IS NOT NULL)
    OR (cost_scope_type = 'SHARED' AND fulfillment_center_id IS NULL)
  )
);

CREATE TABLE logiplan.variance_comparison (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  comparison_id text NOT NULL,
  budget_version_id text NOT NULL,
  comparison_scenario_version_id text NOT NULL,
  period_start date NOT NULL CHECK (date_trunc('month', period_start)::date = period_start),
  period_end date NOT NULL CHECK (date_trunc('month', period_end)::date = period_end),
  latest_closed_month date
    CHECK (latest_closed_month IS NULL OR date_trunc('month', latest_closed_month)::date = latest_closed_month),
  calculation_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('VALIDATED', 'PUBLISHED', 'SUPERSEDED')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (data_release_id, comparison_id),
  FOREIGN KEY (data_release_id, budget_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  FOREIGN KEY (data_release_id, comparison_scenario_version_id)
    REFERENCES logiplan.scenario_version (data_release_id, scenario_version_id),
  CHECK (period_end >= period_start)
);

CREATE TABLE logiplan.variance_attribution_fact (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  attribution_fact_id text NOT NULL,
  comparison_id text NOT NULL,
  month_id date NOT NULL CHECK (date_trunc('month', month_id)::date = month_id),
  route_id text NOT NULL,
  cost_category text NOT NULL CHECK (
    cost_category IN (
      'BASE_FREIGHT', 'FUEL_SURCHARGE', 'BILLABLE_EXCEPTION',
      'FRONTLINE_VARIABLE_LABOR', 'PACKAGING', 'RETURN_LOGISTICS'
    )
  ),
  attribution_method text NOT NULL CHECK (attribution_method IN ('CHAIN_SUBSTITUTION', 'SHAPLEY')),
  factor text NOT NULL CHECK (factor IN ('VOLUME', 'MIX', 'EFFICIENCY', 'PRICE', 'FX')),
  attribution_cny numeric(50,24) NOT NULL,
  calculation_version text NOT NULL,
  PRIMARY KEY (data_release_id, attribution_fact_id),
  FOREIGN KEY (data_release_id, comparison_id)
    REFERENCES logiplan.variance_comparison (data_release_id, comparison_id),
  FOREIGN KEY (data_release_id, route_id)
    REFERENCES logiplan.fulfillment_route (data_release_id, route_id),
  UNIQUE (
    data_release_id, comparison_id, month_id, route_id,
    cost_category, attribution_method, factor
  )
);

CREATE TABLE logiplan.attribution_sensitivity_result (
  data_release_id text NOT NULL REFERENCES logiplan.data_release (data_release_id),
  sensitivity_result_id text NOT NULL,
  comparison_id text NOT NULL,
  period_start date NOT NULL CHECK (date_trunc('month', period_start)::date = period_start),
  period_end date NOT NULL CHECK (date_trunc('month', period_end)::date = period_end),
  destination_country_id text,
  factor text NOT NULL CHECK (factor IN ('VOLUME', 'MIX', 'EFFICIENCY', 'PRICE', 'FX')),
  chain_attribution_cny numeric(50,24) NOT NULL,
  shapley_attribution_cny numeric(50,24) NOT NULL,
  absolute_difference_cny numeric(50,24) NOT NULL CHECK (absolute_difference_cny >= 0),
  normalized_difference numeric(50,24),
  amount_threshold_cny numeric(50,24) NOT NULL CHECK (amount_threshold_cny >= 0),
  is_order_sensitive boolean NOT NULL,
  PRIMARY KEY (data_release_id, sensitivity_result_id),
  FOREIGN KEY (data_release_id, comparison_id)
    REFERENCES logiplan.variance_comparison (data_release_id, comparison_id),
  FOREIGN KEY (data_release_id, destination_country_id)
    REFERENCES logiplan.dim_destination_country (data_release_id, destination_country_id),
  CHECK (period_end >= period_start)
);

CREATE VIEW logiplan.active_release
WITH (security_barrier = true) AS
SELECT r.*
FROM logiplan.data_release AS r
JOIN logiplan.active_data_release AS a USING (data_release_id)
WHERE r.status = 'ACTIVE';

CREATE VIEW logiplan.active_destination_country
WITH (security_barrier = true) AS
SELECT d.*
FROM logiplan.dim_destination_country AS d
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_fulfillment_center
WITH (security_barrier = true) AS
SELECT d.*
FROM logiplan.dim_fulfillment_center AS d
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_carrier
WITH (security_barrier = true) AS
SELECT d.*
FROM logiplan.dim_carrier AS d
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_transport_mode
WITH (security_barrier = true) AS
SELECT d.*
FROM logiplan.dim_transport_mode AS d
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_fulfillment_route
WITH (security_barrier = true) AS
SELECT r.*
FROM logiplan.fulfillment_route AS r
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_business_event_note
WITH (security_barrier = true) AS
SELECT n.*
FROM logiplan.business_event_note AS n
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_scenario_version
WITH (security_barrier = true) AS
SELECT s.*
FROM logiplan.scenario_version AS s
JOIN logiplan.active_data_release AS a USING (data_release_id)
WHERE s.status = 'PUBLISHED';

CREATE VIEW logiplan.active_fulfillment_scenario_fact
WITH (security_barrier = true) AS
SELECT f.*
FROM logiplan.fulfillment_scenario_fact AS f
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_scenario_cost_component_fact
WITH (security_barrier = true) AS
SELECT f.*
FROM logiplan.scenario_cost_component_fact AS f
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_scenario_gmv_fact
WITH (security_barrier = true) AS
SELECT f.*
FROM logiplan.scenario_gmv_fact AS f
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_fixed_cost_scenario_fact
WITH (security_barrier = true) AS
SELECT f.*
FROM logiplan.fixed_cost_scenario_fact AS f
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_variance_comparison
WITH (security_barrier = true) AS
SELECT c.*
FROM logiplan.variance_comparison AS c
JOIN logiplan.active_data_release AS a USING (data_release_id)
WHERE c.status = 'PUBLISHED';

CREATE VIEW logiplan.active_variance_attribution_fact
WITH (security_barrier = true) AS
SELECT f.*
FROM logiplan.variance_attribution_fact AS f
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE VIEW logiplan.active_attribution_sensitivity_result
WITH (security_barrier = true) AS
SELECT s.*
FROM logiplan.attribution_sensitivity_result AS s
JOIN logiplan.active_data_release AS a USING (data_release_id);

CREATE FUNCTION logiplan.enforce_candidate_release_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, logiplan
AS $$
DECLARE
  target_data_release_id text;
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_data_release_id := OLD.data_release_id;
  ELSE
    target_data_release_id := NEW.data_release_id;
  END IF;

  SELECT status
  INTO target_status
  FROM logiplan.data_release
  WHERE data_release_id = target_data_release_id;

  IF target_status IS DISTINCT FROM 'CANDIDATE' THEN
    RAISE EXCEPTION
      '只有候选发布允许修改业务数据：%（当前状态：%）',
      target_data_release_id,
      COALESCE(target_status, 'NOT_FOUND');
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target_table text;
BEGIN
  FOR target_table IN
    SELECT c.relname
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'logiplan'
      AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN ('data_release', 'active_data_release')
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER enforce_candidate_release_write
       BEFORE INSERT OR UPDATE OR DELETE ON logiplan.%I
       FOR EACH ROW EXECUTE FUNCTION logiplan.enforce_candidate_release_write()',
      target_table
    );
  END LOOP;
END;
$$;

CREATE FUNCTION logiplan.create_data_release_candidate(
  p_data_release_id text,
  p_release_version text,
  p_input_checksum_sha256 text,
  p_database_schema_version text,
  p_calculation_version text,
  p_generator_version text,
  p_source_description text,
  p_generated_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logiplan
AS $$
BEGIN
  INSERT INTO logiplan.data_release (
    data_release_id,
    release_version,
    status,
    input_checksum_sha256,
    database_schema_version,
    calculation_version,
    generator_version,
    source_description,
    generated_at
  ) VALUES (
    p_data_release_id,
    p_release_version,
    'CANDIDATE',
    p_input_checksum_sha256,
    p_database_schema_version,
    p_calculation_version,
    p_generator_version,
    p_source_description,
    p_generated_at
  )
  ON CONFLICT (data_release_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM logiplan.data_release
    WHERE data_release_id = p_data_release_id
      AND release_version = p_release_version
      AND input_checksum_sha256 = p_input_checksum_sha256
      AND database_schema_version = p_database_schema_version
      AND calculation_version = p_calculation_version
      AND generator_version = p_generator_version
      AND source_description = p_source_description
      AND generated_at = p_generated_at
  ) THEN
    RAISE EXCEPTION '发布标识已存在但元数据不一致：%', p_data_release_id;
  END IF;
END;
$$;

CREATE FUNCTION logiplan.mark_data_release_validated(
  p_data_release_id text,
  p_validation_summary jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logiplan
AS $$
BEGIN
  UPDATE logiplan.data_release
  SET status = 'VALIDATED',
      validation_summary = p_validation_summary,
      validated_at = clock_timestamp()
  WHERE data_release_id = p_data_release_id
    AND status = 'CANDIDATE';

  IF NOT FOUND THEN
    RAISE EXCEPTION '候选发布不存在或状态不允许校验：%', p_data_release_id;
  END IF;
END;
$$;

CREATE FUNCTION logiplan.mark_data_release_failed(
  p_data_release_id text,
  p_validation_summary jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, logiplan
AS $$
BEGIN
  UPDATE logiplan.data_release
  SET status = 'FAILED',
      validation_summary = p_validation_summary,
      validated_at = NULL,
      activated_at = NULL
  WHERE data_release_id = p_data_release_id
    AND status = 'CANDIDATE';

  IF NOT FOUND THEN
    RAISE EXCEPTION '候选发布不存在或状态不允许失败关闭：%', p_data_release_id;
  END IF;
END;
$$;

CREATE FUNCTION logiplan.activate_data_release(
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
      AND status = 'VALIDATED'
  ) THEN
    RAISE EXCEPTION '只有已校验发布才能激活：%', p_data_release_id;
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

REVOKE ALL ON SCHEMA logiplan FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA logiplan FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA logiplan FROM PUBLIC;

GRANT USAGE ON SCHEMA logiplan TO data_publisher, app_reader;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA logiplan TO data_publisher;
REVOKE INSERT ON
  logiplan.data_release,
  logiplan.active_data_release
FROM data_publisher;
REVOKE ALL ON
  logiplan.active_release,
  logiplan.active_destination_country,
  logiplan.active_fulfillment_center,
  logiplan.active_carrier,
  logiplan.active_transport_mode,
  logiplan.active_fulfillment_route,
  logiplan.active_business_event_note,
  logiplan.active_scenario_version,
  logiplan.active_fulfillment_scenario_fact,
  logiplan.active_scenario_cost_component_fact,
  logiplan.active_scenario_gmv_fact,
  logiplan.active_fixed_cost_scenario_fact,
  logiplan.active_variance_comparison,
  logiplan.active_variance_attribution_fact,
  logiplan.active_attribution_sensitivity_result
FROM data_publisher;
GRANT EXECUTE ON FUNCTION
  logiplan.create_data_release_candidate(text, text, text, text, text, text, text, timestamptz),
  logiplan.mark_data_release_validated(text, jsonb),
  logiplan.mark_data_release_failed(text, jsonb),
  logiplan.activate_data_release(text)
TO data_publisher;

REVOKE ALL ON ALL TABLES IN SCHEMA logiplan FROM app_reader;
GRANT SELECT ON
  logiplan.active_release,
  logiplan.active_destination_country,
  logiplan.active_fulfillment_center,
  logiplan.active_carrier,
  logiplan.active_transport_mode,
  logiplan.active_fulfillment_route,
  logiplan.active_business_event_note,
  logiplan.active_scenario_version,
  logiplan.active_fulfillment_scenario_fact,
  logiplan.active_scenario_cost_component_fact,
  logiplan.active_scenario_gmv_fact,
  logiplan.active_fixed_cost_scenario_fact,
  logiplan.active_variance_comparison,
  logiplan.active_variance_attribution_fact,
  logiplan.active_attribution_sensitivity_result
TO app_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE schema_migrator IN SCHEMA logiplan
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE schema_migrator IN SCHEMA logiplan
  GRANT SELECT ON TABLES TO data_publisher;
ALTER DEFAULT PRIVILEGES FOR ROLE schema_migrator IN SCHEMA logiplan
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
