import Link from "next/link";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function AttributionPage() {
  return (
    <main>
      <h1>归因分析</h1>
      <p>正式页面将在第一闸门内按已验收方案 B 实现。</p>
      <Link href="/">返回驾驶舱</Link>
    </main>
  );
}
