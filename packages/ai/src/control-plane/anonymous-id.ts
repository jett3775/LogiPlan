/**
 * 匿名标识派生（docs/gate2-design.md §3.1、docs/decisions.md D-181）。
 *
 * D-181 原文：「服务端使用每日轮换密钥对规范化 IP 与 User-Agent 摘要做 HMAC，
 * 限流系统与供应商 `safety_identifier` 只使用不可逆派生值；不得记录或持久化
 * 原始 IP 和完整 User-Agent。」
 *
 * 实现口径：
 * 1. **规范化 IP**：去空白、小写、剥掉 IPv6 方括号与 `%zone` 后缀。
 * 2. **UA 摘要**：先对完整 User-Agent 做 SHA-256，得到定长摘要；完整 UA 不进入派生输入。
 * 3. **每日轮换密钥**：`dailyKey = HMAC(masterSecret, "版本:YYYY-MM-DD(UTC)")`，
 *    日界为 UTC，跨日自动轮换。
 * 4. **匿名标识**：`HMAC(dailyKey, 规范化IP ‖ UA摘要)`，十六进制。
 *
 * 不可逆性来源是 HMAC 的密钥（`masterSecret` 只存在于服务端环境变量，D-177）：
 * 没有密钥无法从派生值反推 IP 或 UA；每日轮换使跨日不可关联。
 *
 * 使用 Web Crypto（`globalThis.crypto`）而非 `node:crypto`，使本模块不引入 Node 内建
 * 依赖，从而可安全地被服务端与（经 barrel 导出的）浏览器包共同引用。
 */

/** 派生算法版本；进入 HMAC 输入，版本变化即派生值整体变化。 */
export const ANON_ID_DERIVATION_VERSION = "logiplan.ai.anon.v1";

const textEncoder = new TextEncoder();

/** 复制为独立的 `ArrayBuffer`：DOM 与 Node 的 `BufferSource` 对 `Uint8Array<ArrayBufferLike>` 判定不同。 */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const utf8 = (message: string): ArrayBuffer => toArrayBuffer(textEncoder.encode(message));

/** 去空白、小写、剥 IPv6 方括号与 zone 后缀。 */
export const normalizeIp = (rawIp: string): string => {
  const trimmed = rawIp.trim().toLowerCase();
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const zoneIndex = withoutBrackets.indexOf("%");
  return zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacSha256Hex = async (keyBytes: Uint8Array, message: string): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, utf8(message));
  return toHex(new Uint8Array(signature));
};

const sha256Hex = async (message: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8(message));
  return toHex(new Uint8Array(digest));
};

/** UTC 日戳 `YYYY-MM-DD`；每日轮换的日界。 */
export const anonymousDayStamp = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

/** 当日轮换密钥：`HMAC(masterSecret, "版本:YYYY-MM-DD")`。 */
export const dailyAnonymousKey = async (secret: string, nowMs: number): Promise<string> =>
  hmacSha256Hex(
    textEncoder.encode(secret),
    `${ANON_ID_DERIVATION_VERSION}:${anonymousDayStamp(nowMs)}`,
  );

/** 完整 User-Agent 的定长摘要；完整 UA 不进入匿名标识输入。 */
export const digestUserAgent = (userAgent: string): Promise<string> => sha256Hex(userAgent);

export interface AnonymousIdInput {
  readonly rawIp: string;
  readonly userAgent: string;
  /** 服务端主密钥；只来自环境变量（D-177），不得进入日志或存储。 */
  readonly secret: string;
  readonly nowMs: number;
}

/**
 * 派生匿名标识：`HMAC(dailyKey, 规范化IP ‖ UA摘要)`。
 *
 * 返回值为不可逆派生值，只用于限流键与供应商 `safety_identifier`；
 * 原始 IP 与完整 UA 不落盘、不入日志（D-138、D-181）。
 */
export const deriveAnonymousId = async (input: AnonymousIdInput): Promise<string> => {
  const dayKey = await dailyAnonymousKey(input.secret, input.nowMs);
  const userAgentDigest = await digestUserAgent(input.userAgent);
  return hmacSha256Hex(
    textEncoder.encode(dayKey),
    `${normalizeIp(input.rawIp)}\u2016${userAgentDigest}`,
  );
};
