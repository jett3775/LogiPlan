import { notFound } from "next/navigation";
import { attributionFactorSchema } from "@logiplan/contracts";

import { AiWorkspace } from "../ai-workspace";
import { AttributionWorkspace } from "../attribution-workspace";
import { HistoricalEvidenceWorkspace } from "../dashboard-workspace";
import { VERSIONS, currentAnalysisAddressFromParams, hasEvidenceAddress } from "../lib/model";
import { loadAttributionData } from "../lib/query-server";
import styles from "../workspace.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function AttributionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (hasEvidenceAddress(params))
    return (
      <HistoricalEvidenceWorkspace
        returnHref={currentAnalysisAddressFromParams("/attribution", params)}
      />
    );
  const scalar = (key: string) => (typeof params[key] === "string" ? params[key] : undefined);
  const fixed = {
    period: "2026-08",
    comparison: "ACTUAL_VS_BUDGET",
    destination: "GB",
    budget: VERSIONS.budget,
    actual: VERSIONS.actual,
    method: "CHAIN",
  } as const;
  for (const [key, expected] of Object.entries(fixed)) {
    const value = scalar(key);
    if (value !== undefined && value !== expected) notFound();
  }
  const parsedFactor = attributionFactorSchema.safeParse(scalar("factor"));
  const factor = parsedFactor.success ? parsedFactor.data : undefined;
  if (scalar("factor") !== undefined && !parsedFactor.success) notFound();
  const data = await loadAttributionData(factor);
  const path = scalar("path")?.split("~").filter(Boolean) ?? [];
  const guideValue = Number.parseInt(scalar("guide") ?? "0", 10);
  return (
    <>
      <AttributionWorkspace
        initialData={data}
        initialFactor={factor ?? null}
        initialPath={path}
        initialEvidenceId={scalar("evidence_id") ?? null}
        initialGuide={guideValue === 3 || guideValue === 4 ? guideValue : 0}
      />
      {/* 闸门二切片 1b 的 AI 管理分析提问区块：追加挂载，不改动既有工作台的任何区块。
          未提问时只渲染表单，因此既有断言（如 gate1 的「相关性不等于因果」）零影响。 */}
      <div className={styles.main}>
        <AiWorkspace />
      </div>
    </>
  );
}
