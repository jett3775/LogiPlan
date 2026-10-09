import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  controlPlaneUnavailableDecision,
  createControlPlaneFromEnvironment,
  emitControlPlaneAudit,
  evaluateControlPlane,
  type ControlPlaneDecision,
  type ControlPlaneRequest,
} from "@logiplan/ai/server";

import {
  AI_RESPOND_STATUS_ZH,
  parseAiRespondRequest,
  validatePageAddress,
  type AiRespondBody,
  type AiRespondFailure,
} from "../../../../lib/ai-model";
import { answerManagementQuestion } from "../../../../lib/ai-server";

/**
 * `POST /api/v1/ai/respond`（docs/gate2-implementation-plan.md 切片 1b / 切片 2）。
 *
 * HTTP 层的范式与 `/api/v1/query` 逐项对齐：`content-type` 必须是 `application/json`
 * （否则 415）、请求体 16 KiB 上限、`X-Request-Id` 响应头、`dynamic`/`runtime` 显式声明。
 *
 * 与 `/api/v1/query` 的关键差异：本路由**不接受**任何查询意图。浏览器只提交自然语言
 * 问题与页面范围地址；确定性查询与证据白名单组装在服务端内部完成
 * （`lib/ai-server.ts`），`MANAGEMENT_ANALYSIS` 不经过本仓库的查询意图入口。
 *
 * 切片 2 追加：成本包围门控接缝（见 `applyCostGuard`）。本切片**仍无真实模型调用路径**
 * （AC2.12），门控结果恒不改变本路由的输出。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const CONTROL_PLANE_ROLE = "management_analysis" as const;

/**
 * 成本包围门控接缝（docs/gate2-implementation-plan.md §4「接入失败关闭」）。
 *
 * 只决定「是否**允许**真实调用」：限流命中、L1/L2 熔断、Upstash 不可用/超时/不确定
 * 一律失败关闭。本切片**不存在**真实调用路径，因此 `liveCallPermitted` 恒不改变本路由
 * 的输出（`answer_type` 仍为 `FIXED_EXAMPLE`）；切片 3 将在此消费该许可，为 false 时
 * 跳过模型调用、直接回落固定示例。
 *
 * 未配置控制面（缺主密钥或 Redis 凭据）时按「不可用 → 失败关闭」处理；装配与评估都不
 * 允许抛出到请求处理链。
 */
const applyCostGuard = async (
  request: Request,
  requestId: string,
): Promise<ControlPlaneDecision> => {
  const environment = process.env["NODE_ENV"] ?? "unknown";
  const controlRequest: ControlPlaneRequest = {
    request_id: requestId,
    role: CONTROL_PLANE_ROLE,
    // 只把原始 IP 交给匿名派生；派生值不可逆，原始 IP 不落盘、不入日志（D-181/D-138）。
    rawIp: (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  };
  try {
    const runtime = await createControlPlaneFromEnvironment(process.env);
    if (runtime === null) {
      return controlPlaneUnavailableDecision(environment, controlRequest, Date.now());
    }
    return await evaluateControlPlane(runtime.deps, runtime.config, controlRequest);
  } catch {
    return controlPlaneUnavailableDecision(environment, controlRequest, Date.now());
  }
};

const fail = (
  requestId: string,
  status: AiRespondFailure["status"],
  message_zh: string,
  httpStatus: number,
): NextResponse<AiRespondBody> =>
  NextResponse.json(
    {
      ok: false,
      status,
      status_label_zh: AI_RESPOND_STATUS_ZH[status],
      message_zh,
      request_id: requestId,
    } satisfies AiRespondFailure,
    {
      status: httpStatus,
      headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
    },
  );

export async function POST(request: Request) {
  const requestId = randomUUID();
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return fail(requestId, "INPUT_REJECTED", "AI 回答接口只接受 application/json", 415);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return fail(requestId, "INPUT_REJECTED", "请求体超过 16 KiB 限制", 400);
    }
    body = JSON.parse(text) as unknown;
  } catch {
    return fail(requestId, "INPUT_REJECTED", "请求体必须是合法 JSON", 400);
  }

  const parsed = parseAiRespondRequest(body);
  if (!parsed.ok) {
    return fail(requestId, "INPUT_REJECTED", parsed.message_zh, 400);
  }
  // 地址校验已在 `parseAiRespondRequest` 内做过一次；此处是服务端自身的防御性复核，
  // 保证任何绕过解析器的调用方也拿不到白名单组装的机会。
  const addressProblem = validatePageAddress(parsed.pageAddress);
  if (addressProblem !== null) {
    return fail(requestId, "INPUT_REJECTED", addressProblem, 400);
  }

  // 切片 2：成本包围门控接缝。本切片无真实调用路径，门控结果只被审计、不改变输出
  // （`liveCallPermitted` 恒不参与响应构造）；切片 3 在此消费该许可。
  const decision = await applyCostGuard(request, requestId);
  emitControlPlaneAudit(decision.audit);

  const outcome = await answerManagementQuestion(parsed.pageAddress);
  if (!outcome.ok) {
    return fail(requestId, outcome.status, outcome.message_zh, 503);
  }
  return NextResponse.json(
    {
      ok: true,
      status: "FIXED_EXAMPLE",
      status_label_zh: AI_RESPOND_STATUS_ZH.FIXED_EXAMPLE,
      answer: outcome.answer,
      request_id: requestId,
    } satisfies AiRespondBody,
    { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
  );
}
