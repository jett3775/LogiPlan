import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  AI_RESPOND_STATUS_ZH,
  parseAiRespondRequest,
  validatePageAddress,
  type AiRespondBody,
  type AiRespondFailure,
} from "../../../../lib/ai-model";
import { answerManagementQuestion } from "../../../../lib/ai-server";

/**
 * `POST /api/v1/ai/respond`（docs/gate2-implementation-plan.md 切片 1b / 切片 2 / D-192 装配层）。
 *
 * HTTP 层的范式与 `/api/v1/query` 逐项对齐：`content-type` 必须是 `application/json`
 * （否则 415）、请求体 16 KiB 上限、`X-Request-Id` 响应头、`dynamic`/`runtime` 显式声明。
 *
 * 与 `/api/v1/query` 的关键差异：本路由**不接受**任何查询意图。浏览器只提交自然语言
 * 问题与页面范围地址；确定性查询、证据白名单、控制面预检与结算全部在服务端内部完成
 * （`lib/ai-server.ts`，D-192 的四层装配边界）。
 *
 * ## 本部署不发起任何真实调用
 *
 * 适配器恒为 `null`（门 C 未开启）⇒ 会话不做预检、直接回落固定示例。因此本路由的输出
 * 在配置不变的前提下**始终**是 `FIXED_EXAMPLE`；`LIVE_GENERATED` 分支已接线并有集成测试
 * 覆盖（`packages/ai/src/gateway/gateway-session.test.ts`），但要真正走到它必须显式开启门 C。
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;

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

  const outcome = await answerManagementQuestion(parsed.pageAddress, parsed.question, requestId, {
    environment: process.env,
    // 门 C 未开启：本部署**不装配**任何供应商适配器（`LOGIPLAN_AI_LIVE_CALLS` 未开启），
    // 会话因此跳过预检与结算、直接回落固定示例——零真实调用、零付费。
    adapter: null,
    // 只把原始 IP 交给匿名派生；派生值不可逆，原始 IP 不落盘、不入日志（D-181/D-138）。
    rawIp: (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!outcome.ok) {
    return fail(requestId, outcome.status, outcome.message_zh, 503);
  }
  return NextResponse.json(
    {
      ok: true,
      status: outcome.status,
      status_label_zh: AI_RESPOND_STATUS_ZH[outcome.status],
      answer: outcome.answer,
      request_id: requestId,
    } satisfies AiRespondBody,
    { status: 200, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" } },
  );
}
