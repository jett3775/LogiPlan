import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <h1>未找到对应分析范围</h1>
      <p>地址中的期间、比较口径、版本、因素或证据标识不受当前固定演示范围支持。</p>
      <Link href="/">返回预算执行驾驶舱</Link>
    </main>
  );
}
