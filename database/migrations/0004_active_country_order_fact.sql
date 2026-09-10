CREATE VIEW logiplan.active_country_order_fact
WITH (security_barrier = true) AS
SELECT
  b.data_release_id,
  b.scenario_version_id,
  s.scenario_type,
  b.month_id,
  b.destination_country_id,
  b.order_qty,
  'budget_country_month'::text AS source_model
FROM logiplan.budget_country_month AS b
JOIN logiplan.active_data_release AS a USING (data_release_id)
JOIN logiplan.scenario_version AS s
  ON s.data_release_id = b.data_release_id
 AND s.scenario_version_id = b.scenario_version_id
WHERE s.status = 'PUBLISHED'
  AND s.scenario_type = 'BUDGET'
UNION ALL
SELECT
  a.data_release_id,
  a.scenario_version_id,
  s.scenario_type,
  a.month_id,
  a.destination_country_id,
  sum(a.order_qty) AS order_qty,
  'actual_country_warehouse_fulfillment'::text AS source_model
FROM logiplan.actual_country_warehouse_fulfillment AS a
JOIN logiplan.active_data_release AS active USING (data_release_id)
JOIN logiplan.scenario_version AS s
  ON s.data_release_id = a.data_release_id
 AND s.scenario_version_id = a.scenario_version_id
WHERE s.status = 'PUBLISHED'
  AND s.scenario_type = 'ACTUAL'
GROUP BY
  a.data_release_id,
  a.scenario_version_id,
  s.scenario_type,
  a.month_id,
  a.destination_country_id;

REVOKE ALL ON logiplan.active_country_order_fact FROM PUBLIC, data_publisher;
GRANT SELECT ON logiplan.active_country_order_fact TO app_reader;
