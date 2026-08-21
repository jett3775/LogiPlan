import { randomUUID } from "node:crypto";

import { Client } from "pg";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function verify(): Promise<void> {
  const publisher = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-release-workflow-verifier",
  });
  const reader = new Client({
    connectionString: requiredEnvironment("DATABASE_URL"),
    application_name: "logiplan-release-reader-verifier",
  });
  await Promise.all([publisher.connect(), reader.connect()]);
  try {
    const before = await reader.query<{ data_release_id: string; status: string }>(
      "SELECT data_release_id, status FROM logiplan.active_release",
    );
    const active = before.rows[0];
    assert(before.rowCount === 1 && active?.status === "ACTIVE", "验证前必须存在唯一活动发布");

    const probeId = `rollback-probe-${randomUUID()}`;
    await publisher.query("BEGIN");
    try {
      await publisher.query(
        `SELECT logiplan.create_data_release_candidate(
           $1, $1, repeat('0', 64), '0003', 'verify', 'verify', '回切事务验收', clock_timestamp()
         )`,
        [probeId],
      );
      await publisher.query("SELECT logiplan.mark_data_release_validated($1, $2::jsonb)", [
        probeId,
        JSON.stringify({ status: "PASS", purpose: "rollback-verification" }),
      ]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [probeId]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [active.data_release_id]);

      const inside = await publisher.query<{ data_release_id: string; status: string }>(
        `SELECT a.data_release_id, r.status
         FROM logiplan.active_data_release AS a
         JOIN logiplan.data_release AS r USING (data_release_id)
         WHERE a.singleton`,
      );
      assert(
        inside.rowCount === 1 &&
          inside.rows[0]?.data_release_id === active.data_release_id &&
          inside.rows[0].status === "ACTIVE",
        "退役发布未能在同一事务中安全回切",
      );
    } finally {
      await publisher.query("ROLLBACK");
    }

    const after = await reader.query<{ data_release_id: string; status: string }>(
      "SELECT data_release_id, status FROM logiplan.active_release",
    );
    assert(
      after.rowCount === 1 &&
        after.rows[0]?.data_release_id === active.data_release_id &&
        after.rows[0].status === "ACTIVE",
      "回切验收事务回滚后活动发布发生变化",
    );
  } finally {
    await Promise.all([publisher.end(), reader.end()]);
  }
}

await verify()
  .then(() => {
    process.stdout.write("发布激活、退役回切和应用可见性验证通过\n");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知发布流程验证错误";
    process.stderr.write(`发布流程验证失败：${message}\n`);
    process.exitCode = 1;
  });
