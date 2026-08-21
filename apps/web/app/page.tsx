import Link from "next/link";

import { compatibilityStatusSchema } from "@logiplan/contracts";
import { addExactDecimals } from "@logiplan/domain";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function DashboardPage() {
  const status = compatibilityStatusSchema.parse({ state: "ready" });
  const exactCheck = addExactDecimals("0.1", "0.2");

  return (
    <main>
      <h1>LogiPlan 正式工程</h1>
      <p>兼容性骨架状态：{status.state === "ready" ? "已就绪" : "未就绪"}</p>
      <p>精确十进制检查：0.1 + 0.2 = {exactCheck}</p>
      <Link href="/attribution">进入归因分析骨架</Link>
    </main>
  );
}
