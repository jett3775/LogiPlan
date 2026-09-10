import { DashboardWorkspace, HistoricalEvidenceWorkspace } from "./dashboard-workspace";
import { currentAnalysisAddressFromParams, hasEvidenceAddress } from "./lib/model";
import { loadDashboardData } from "./lib/query-server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (hasEvidenceAddress(params))
    return (
      <HistoricalEvidenceWorkspace returnHref={currentAnalysisAddressFromParams("/", params)} />
    );
  const data = await loadDashboardData();
  const guide = typeof params.guide === "string" ? Number.parseInt(params.guide, 10) : 0;
  const evidenceId = typeof params.evidence_id === "string" ? params.evidence_id : null;
  return (
    <DashboardWorkspace
      data={data}
      initialGuide={guide === 1 || guide === 2 ? guide : 0}
      initialEvidenceId={evidenceId}
    />
  );
}
