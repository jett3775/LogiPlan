import { describe, expect, it, vi } from "vitest";

import { reportActivationFailure } from "./activate-release";
import { writeOutcomeUnknownExitCode } from "./transaction-outcome";

// CLI 失败归类属于进程级副作用（写 stderr + 改 process.exitCode）。测试直接注入错误对象，
// 断言导出的报告函数；调用后必须还原 exitCode，避免污染 vitest 自身的退出码。
function numericExitCode(): number | undefined {
  return typeof process.exitCode === "number" ? process.exitCode : undefined;
}

function captureFailureReport(error: unknown): { stderr: string; exitCode: number | undefined } {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const previousExitCode = numericExitCode();
  try {
    reportActivationFailure(error);
    return { stderr: String(stderr.mock.calls[0]?.[0] ?? ""), exitCode: numericExitCode() };
  } finally {
    stderr.mockRestore();
    process.exitCode = previousExitCode;
  }
}

describe("activate-release CLI 失败归类", () => {
  it("激活写入结果未知时以 75 结束，并带 [WRITE_OUTCOME_UNKNOWN] 前缀", () => {
    const error = Object.assign(new Error("COMMIT 确认丢失，发布结果未知；必须先只读核对再重试"), {
      writeOutcomeUnknown: true,
    });

    const { stderr, exitCode } = captureFailureReport(error);

    expect(exitCode).toBe(writeOutcomeUnknownExitCode);
    expect(exitCode).toBe(75);
    expect(stderr.startsWith("[WRITE_OUTCOME_UNKNOWN] ")).toBe(true);
    expect(stderr).toContain("发布切换失败：COMMIT 确认丢失");
  });

  it("已确认回滚时以 1 结束，且不带任何未知写入前缀", () => {
    const error = Object.assign(new Error("materialization failed"), { rollbackConfirmed: true });

    const { stderr, exitCode } = captureFailureReport(error);

    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("[WRITE_OUTCOME_UNKNOWN]");
    expect(stderr).not.toContain("[WRITE_COMMITTED_OBSERVATION_FAILED]");
    expect(stderr).toBe("发布切换失败：materialization failed\n");
  });

  it("非 Error 抛出物沿用未知发布切换错误文案，且不带前缀", () => {
    const { stderr, exitCode } = captureFailureReport("boom");

    expect(exitCode).toBe(1);
    expect(stderr).toBe("发布切换失败：未知发布切换错误\n");
  });
});
