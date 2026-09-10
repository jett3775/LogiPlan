import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createReadOnlyPool, runDeterministicQuery } from "@logiplan/db";
import { deterministicResultSchema } from "@logiplan/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pool = process.env.DATABASE_URL ? createReadOnlyPool(process.env.DATABASE_URL) : null;
const MAX_BODY_BYTES = 16 * 1024;
const QUERY_TIMEOUT_MS = 10_000;

class QueryTimeoutError extends Error {
  override name = "QueryTimeoutError";
}

export async function POST(request: Request) {
  const request_id = randomUUID();
  const headers = { "X-Request-Id": request_id, "Cache-Control": "no-store" };
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return NextResponse.json(
      {
        error_id: `ERR-${request_id}`,
        code: "INVALID_FILTER",
        message_zh: "查询接口只接受 application/json",
        request_id,
      },
      { status: 415, headers },
    );
  }
  if (!pool) {
    return NextResponse.json(
      {
        error_id: `ERR-${request_id}`,
        code: "VERSION_NOT_FOUND",
        message_zh: "服务端未配置数据库连接",
        request_id,
      },
      { status: 503, headers },
    );
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          error_id: `ERR-${request_id}`,
          code: "INVALID_FILTER",
          message_zh: "请求体超过 16 KiB 限制",
          request_id,
        },
        { status: 400, headers },
      );
    }
    const query = runDeterministicQuery(pool, JSON.parse(text) as unknown, request_id);
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new QueryTimeoutError()), QUERY_TIMEOUT_MS);
    });
    const result = await Promise.race([query, deadline]);
    if ("code" in result) return NextResponse.json(result, { status: 400, headers });
    const validated = deterministicResultSchema.safeParse(result);
    if (!validated.success) {
      return NextResponse.json(
        {
          type: "QUERY_TIMEOUT",
          message_zh: "查询服务返回结果未通过 V1 运行时契约校验",
          request_id,
        },
        { status: 503, headers },
      );
    }
    return NextResponse.json(validated.data, { status: 200, headers });
  } catch (cause) {
    const syntax = cause instanceof SyntaxError;
    const timedOut = cause instanceof QueryTimeoutError;
    return NextResponse.json(
      syntax
        ? {
            error_id: `ERR-${request_id}`,
            code: "INVALID_FILTER",
            message_zh: "请求体必须是合法 JSON",
            request_id,
          }
        : {
            type: "QUERY_TIMEOUT",
            message_zh: timedOut ? "确定性查询超过 10 秒，已停止等待" : "确定性查询服务暂时不可用",
            request_id,
          },
      { status: syntax ? 400 : timedOut ? 504 : 503, headers },
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
