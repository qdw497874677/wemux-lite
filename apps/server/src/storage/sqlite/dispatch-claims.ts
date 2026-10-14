// 派发意图与承接记录：建表与建索引都写成幂等形式，因为历史镜像测试会删掉版本行后重放整个迁移链，
// 非幂等的新迁移会让「旧镜像重开」直接失败。
// 一次执行意图（Task + 接替代次）只能有一个有效承接。
// `task_dispatch_claims_active` 是唯一性权威——并发申领由 SQLite 部分唯一索引裁决，
// 应用层不靠先读后写。`unknown` 表示已接受但结果未知，保留记录且仍然占用该意图，
// 不凭超时释放（D3）。
export const dispatchClaimsMigration = `
CREATE TABLE IF NOT EXISTS task_dispatch_intents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  queue_order INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','cancelled')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(task_id, generation)
);
CREATE INDEX IF NOT EXISTS task_dispatch_intents_queue ON task_dispatch_intents(queue_order);
CREATE INDEX IF NOT EXISTS task_dispatch_intents_task ON task_dispatch_intents(task_id);
CREATE TABLE IF NOT EXISTS task_dispatch_claims (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES task_dispatch_intents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','accepted','released','unknown')),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(intent_id, request_id)
);
-- 有效承接（未释放）在同一执行意图上唯一；释放后新代次或重选机器才能建立承接。
CREATE UNIQUE INDEX IF NOT EXISTS task_dispatch_claims_active ON task_dispatch_claims(intent_id) WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS task_dispatch_claims_worker ON task_dispatch_claims(worker_id, state);
`
