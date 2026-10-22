# 数据库设计

两个服务各自拥有一个数据库，互不直连：底座（media）只懂“媒体、时间、证据”，学习后端（learning）只通过底座的 HTTP 接口和 Webhook 拿数据。模型在 `services/seedots/{media,learning}/models.py`，迁移在 `services/migrations/{media,learning}/versions/`。

## 通用约定（`seedots/common/db.py`）

| 约定 | 做法 | 原因 |
| --- | --- | --- |
| 目标库 | PostgreSQL；开发和测试用 SQLite，同一套模型和迁移 | 本地零依赖，生产不改代码 |
| 枚举 | `VARCHAR + CHECK`（不用 PG 原生 enum） | 新增枚举值只是一次普通迁移 |
| JSON | `JSON`，在 PostgreSQL 上自动变成 `JSONB` | 可建 GIN 索引 |
| 约束命名 | 固定命名规则（`pk_/fk_/uq_/ix_/ck_`） | Alembic 对比稳定、迁移可读 |
| 部分唯一索引 | `postgresql_where` 与 `sqlite_where` 同时声明 | “当前版本唯一”“公开媒体唯一”等规则落在库里 |
| 时间 | 全部 `timestamptz`，UTC | — |
| 事务 | `Database.session()` 是工作单元；模型调用期间不持有事务 | 防止长事务和锁等待 |
| 不可变 | 证据、学习项都是“新增版本 + 标记旧版本被取代”，从不原地改 | 已发生的作答、引用永远指向当时的内容 |

## 底座（10 张表）

```
media_assets ─┬─ media_files            我们持有的文件（原片 / 字幕 / 音频）
              ├─ analysis_jobs ── stage_runs   (media, stage, processor_version) 幂等
              ├─ evidence_units          (id, revision) 主键；superseded_at 标记旧版本
              └─ outbox_events ── webhook_deliveries ── webhook_subscriptions
usage_logs, llm_cache
```

- `media_assets`：公开来源按 `dedupe_key` 全局唯一（部分唯一索引 `visibility='public'`），私有来源按 `(dedupe_key, owner)` 唯一；`private_needs_owner`、`webpage_attested` 两个 CHECK 把“私有必须有主人”“网页必须有权利声明”写死在库里。平台元数据带 `platform_meta_expires_at`（YouTube 政策：30 天）。
- `evidence_units`：句子 / 章节 / 关键帧 / 区域四类证据同一张表。修正 = 新 revision，`uq_evidence_one_current` 保证每个 id 只有一个当前版本。
- `outbox_events` 与状态变化在同一事务提交；每个订阅一条 `webhook_deliveries`，指数退避，失败 12 次进入 `dead`，可人工重放。

## 学习后端（37 张表）

内容层（共享、版本化）、日志层（每人追加写）、派生层（可重建）：

```
内容  videos ── chapters ── content_runs          evidence_snapshots (id, revision)
      concepts ─┬ concept_aliases / misconceptions / concept_embeddings
                ├ occurrences ── occurrence_evidence
                ├ concept_candidates（低置信度归一，待人工）
                └ concept_merge_log（审计；记录移动了哪些行，可回滚）
      learning_items（不可变版本）─┬ item_concepts / item_evidence
                                   ├ item_reviews（追加写，状态投影到 item）
                                   └ item_rejections（自动校验未通过的草稿，供评测）
      scene_specs ── scene_evidence（L1/L2 交互场，随视频共享；progress 记录生成阶段，gates 记录各道闸门结果）
日志  learning_events, decisions, attempts, marks, coach_threads ── coach_messages ── message_citations
派生  mastery, concept_links, knowledge_cards ── card_sources
用户  users, user_settings, library_entries, collections ── collection_items
运维  inbox_events, usage_logs, llm_cache
```

关键规则：

1. **时间只来自证据**：学习项、出现位置、Coach 引用、知识卡片都存 `(evidence_id, evidence_revision)`，时间从快照查，不存模型给的秒数。
2. **学习项版本**：`uq_item_current` 保证一个 `item_key` 只有一个当前版本；作答记录指向具体版本的 `item_id` 和稳定的 `item_key`（“是否首次作答”按 key 判断）。
3. **只有人工审过的才计入掌握**：`review_status` 是 `item_reviews` 的投影；`attempts.counted` 在写入时就定下来。
4. **概念合并可回滚**：`concept_merge_log.detail` 记录每一处移动（出现位置、学习项、别名、误区、掌握度、卡片、链接）；`concepts.merge_target` CHECK 保证“已合并 ⇔ 有合并目标”；活跃概念名唯一（部分唯一索引）。
5. **决策全量记录**：规则结果（`rule_action/rule_item_id`）每次都存，模型结果、是否回退、延迟、最终展示结果（`outcome`）都在同一行，便于离线评测动作选择。
6. **隔离**：`videos.visibility/owner_id` 决定可见性；私有视频随用户删除级联。

## 迁移历史

- `0001` 初始结构
- `0002` 交互场：`scene_specs` 增加 title / request / progress / error / generator / content_run_id / updated_at，新增 `scene_evidence`，状态增加 `queued`（只是换一条 CHECK 约束，示范了“枚举 = VARCHAR + CHECK”的好处）。新增的 NOT NULL 列带 server_default，已有数据可以直接升级；降级会把 `queued` 先改回 `generating`。
- `0003` 决策动作新增 `lab`（邀请学习者去做本章的实验）：`decisions.action` 和 `decisions.rule_action` 换一对 CHECK 约束；降级时先把 `lab` 改回 `none`。实验台实验仍存在 `scene_specs`：`component` 为 `rig:<实验台>`，`spec` 为 v2 规格，答案在 `gates.rig_check`，不需要改表。

## 迁移

```bash
cd services
alembic -n media upgrade head
alembic -n learning revision --autogenerate -m "add x"   # 改模型后生成
```

服务启动时默认自动升级（`SEEDOTS_AUTO_MIGRATE=1`）。`tests/test_platform.py` 会检查：两套迁移在 SQLite 上可升级、可降级，与模型无差异（`alembic check`），并能渲染出 PostgreSQL DDL（JSONB、部分索引）。

## 之后的扩展点

- 向量：`concept_embeddings.vector` 现在是 JSON；上 PostgreSQL 后换成 pgvector 的 `vector` 列并加 HNSW 索引，`ConceptLibrary._recall` 改成 SQL 近邻查询即可。
- 事件量大时：`learning_events` 按月分区；`outbox_events` 已投递的定期归档。
