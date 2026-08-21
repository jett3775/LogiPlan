import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { checkReadiness, createReadOnlyPool } from "@logiplan/db";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const pool = process.env.DATABASE_URL ? createReadOnlyPool(process.env.DATABASE_URL) : null;
export async function GET() {
  const request_id = randomUUID();
  const headers = { "X-Request-Id": request_id, "Cache-Control": "no-store" };
  if (!pool)
    return NextResponse.json(
      { status: "not_ready", message_zh: "服务端未配置数据库连接", request_id },
      { status: 503, headers },
    );
  try {
    return NextResponse.json(
      { status: "ready", ...(await checkReadiness(pool)), request_id },
      { headers },
    );
  } catch {
    return NextResponse.json(
      { status: "not_ready", message_zh: "数据库或活动正式版本不可用", request_id },
      { status: 503, headers },
    );
  }
}
