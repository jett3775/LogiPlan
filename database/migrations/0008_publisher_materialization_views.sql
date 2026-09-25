-- The publisher executes the fixed V1.1 materialization queries inside the
-- activation transaction. Permit reads of their derived active views only;
-- snapshot persistence remains function-only and reader lookup remains separate.
GRANT SELECT ON
  logiplan.active_destination_country,
  logiplan.active_fulfillment_center,
  logiplan.active_carrier,
  logiplan.active_transport_mode,
  logiplan.active_fulfillment_route,
  logiplan.active_scenario_version,
  logiplan.active_fulfillment_scenario_fact,
  logiplan.active_scenario_cost_component_fact,
  logiplan.active_scenario_gmv_fact,
  logiplan.active_fixed_cost_scenario_fact,
  logiplan.active_variance_comparison,
  logiplan.active_variance_attribution_fact,
  logiplan.active_attribution_sensitivity_result
TO data_publisher;
