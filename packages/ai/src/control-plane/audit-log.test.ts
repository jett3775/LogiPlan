import { describe, expect, it } from "vitest";

import { AI_AUDIT_FORBIDDEN_CONTENT_KINDS } from "../audit/audit-metadata";
import {
  buildControlPlaneAuditRecord,
  CONTROL_PLANE_AUDIT_FIELD_NAMES,
  emitControlPlaneAudit,
  type ControlPlaneAuditRecord,
} from "./audit-log";

/**
 * AC2.10（D-138 日志边界）：断言日志字段**恰好**是白名单集合（多一个字段即失败）。
 *
 * 成本包围审计使用**独立**的白名单常量，不就地扩 `AI_AUDIT_FIELD_NAMES`
 * （理由见 `audit-log.ts`）。
 */

const RAW_IP = "203.0.113.7";
const RAW_UA = "Mozilla/5.0 (Windows NT 10.0) LogiPlanTest/1.0";

const RECORD_INPUT: ControlPlaneAuditRecord = {
  occurred_at: "2026-10-08T12:00:00.000Z",
  environment: "test",
  request_id: "REQ-FIXTURE",
  role: "management_analysis",
  event: "DECISION",
  error_code: "RATE_LIMITED",
  rate_limit_remaining: 0,
  budget_used_cny: 12.5,
  budget_cap_cny: 30,
  circuit_state: "closed",
  fell_back_to_fixed_example: true,
};

describe("成本包围审计字段边界", () => {
  it("字段名与白名单完全一致（多一个字段即失败）", () => {
    const record = buildControlPlaneAuditRecord(RECORD_INPUT);
    expect(Object.keys(record)).toEqual([...CONTROL_PLANE_AUDIT_FIELD_NAMES]);
  });

  it("输入即使夹带额外键也不会泄漏到记录", () => {
    const record = buildControlPlaneAuditRecord({
      ...RECORD_INPUT,
      raw_ip: RAW_IP,
      user_agent: RAW_UA,
    } as ControlPlaneAuditRecord);
    expect(Object.keys(record)).toEqual([...CONTROL_PLANE_AUDIT_FIELD_NAMES]);
    expect(record).not.toHaveProperty("raw_ip");
    expect(record).not.toHaveProperty("user_agent");
  });

  it("字段名与 D-138 禁止内容类别不相交", () => {
    const names = new Set<string>(CONTROL_PLANE_AUDIT_FIELD_NAMES);
    for (const forbidden of AI_AUDIT_FORBIDDEN_CONTENT_KINDS) {
      expect(names.has(forbidden), forbidden).toBe(false);
    }
  });

  it("序列化记录中不出现原始 IP、完整 UA、请求体或业务正文", () => {
    const serialized = JSON.stringify(buildControlPlaneAuditRecord(RECORD_INPUT)).toLowerCase();
    for (const marker of [
      RAW_IP.toLowerCase(),
      "mozilla",
      "user_agent",
      "user-agent",
      "raw_ip",
      "question",
      "answer",
      "cookie",
      "authorization",
    ]) {
      expect(serialized, marker).not.toContain(marker);
    }
  });

  it("独立白名单不等于调用审计白名单（两者互不复用）", async () => {
    const { AI_AUDIT_FIELD_NAMES } = await import("../audit/audit-metadata");
    expect([...CONTROL_PLANE_AUDIT_FIELD_NAMES]).not.toEqual([...AI_AUDIT_FIELD_NAMES]);
  });

  it("发射器把记录交给 sink", () => {
    const received: ControlPlaneAuditRecord[] = [];
    emitControlPlaneAudit(buildControlPlaneAuditRecord(RECORD_INPUT), {
      write: (record) => received.push(record),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.request_id).toBe("REQ-FIXTURE");
  });
});
