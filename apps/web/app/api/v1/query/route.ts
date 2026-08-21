import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createReadOnlyPool, runDeterministicQuery } from "@logiplan/db";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const pool = process.env.DATABASE_URL ? createReadOnlyPool(process.env.DATABASE_URL) : null;
export async function POST(request: Request) {
  const request_id = randomUUID();
  const headers = { "X-Request-Id": request_id, "Cache-Control": "no-store" };
  if (!pool)
    return NextResponse.json(
      {
        error_id: `ERR-${request_id}`,
        code: "VERSION_NOT_FOUND",
        message_zh: "服务端未配置数据库连接",
        request_id,
      },
      { status: 503, headers },
    );
  try {
    const text = await request.text();
    if (text.length > 16 * 1024)
      return NextResponse.json(
        {
          error_id: `ERR-${request_id}`,
          code: "INVALID_FILTER",
          message_zh: "请求体超过 16 KiB 限制",
          request_id,
        },
        { status: 400, headers },
      );
    const result = await runDeterministicQuery(pool, JSON.parse(text) as unknown, request_id);
    if ("code" in result) return NextResponse.json(result, { status: 400, headers });
    return NextResponse.json(result, { status: 200, headers });
  } catch (cause) {
    const syntax = cause instanceof SyntaxError;
    return NextResponse.json(
      syntax
        ? {
            error_id: `ERR-${request_id}`,
            code: "INVALID_FILTER",
            message_zh: "请求体必须是合法 JSON",
            request_id,
          }
        : { type: "QUERY_TIMEOUT", message_zh: "确定性查询服务暂时不可用", request_id },
      { status: syntax ? 400 : 503, headers },
    );
  }
}
