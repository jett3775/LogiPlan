"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main role="alert">
      <h1>分析工作台暂时不可用</h1>
      <p>{error.message || "确定性查询失败，请稍后重试。"}</p>
      <button type="button" onClick={reset}>
        重新加载
      </button>
    </main>
  );
}
