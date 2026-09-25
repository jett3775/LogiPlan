import { z } from "zod";

// D-177 要求服务器端在启动或首次使用前集中校验环境变量。
//
// 公开运行环境只持有 app_reader 这一个最小权限只读角色（见 D-176 与
// docs/development-roadmap.md 第 1.1 节）。把校验集中在这里而不是散落在各调用点，是为了让
// 「格式错误」与「指向管理角色」这两类配置错误在首次使用时就明确失败——否则它们要么推迟到
// 查询阶段才暴露，要么（指向直连或管理端点时）静默通过，不会有任何提示。
const appReaderRole = "app_reader";

const runtimeDatabaseUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const parsed = parseRuntimeDatabaseUrl(value);
    if (parsed === null) {
      context.addIssue({
        code: "custom",
        message: "必须是 postgresql:// 或 postgres:// 形式的连接串",
      });
      return;
    }
    if (runtimeRole(parsed) !== appReaderRole) {
      context.addIssue({
        code: "custom",
        message: `用户名必须是 ${appReaderRole}（公开运行环境只允许最小权限只读角色）`,
      });
    }
  });

function parseRuntimeDatabaseUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function runtimeRole(parsed: URL): string {
  try {
    return decodeURIComponent(parsed.username);
  } catch {
    return parsed.username;
  }
}

// 返回校验通过的连接串；未配置或为空串时返回 null，以保持「未配置即不健康」的既有行为
// （生产构建与 /api/health/ready 依赖该行为，见 packages/db/src/index.ts 的 createReadOnlyPool）。
// 校验失败时抛错；错误信息**不回显连接串内容**，避免把凭据写进日志。
export function readWebRuntimeDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const raw = environment.DATABASE_URL;
  if (raw === undefined || raw.trim().length === 0) return null;
  const parsed = runtimeDatabaseUrlSchema.safeParse(raw);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join("；");
    throw new Error(
      `DATABASE_URL 未通过启动校验：${reasons}。为免泄露凭据，此处不回显连接串内容。`,
    );
  }
  return parsed.data;
}
