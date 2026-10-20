# SeeDots 接口文档

版本 v1.0（2026-10-20）。描述两个服务对外的 HTTP 接口、事件和数据契约。设计原因见 [`tech-plan.md`](tech-plan.md)，表结构见 [`database.md`](database.md)。

**维护方式**

- 本文写约定、用途和关键字段；逐字段的请求 / 响应 schema 以服务自动生成的 OpenAPI 为准：学习后端 `http://localhost:8000/docs`（`/openapi.json`），底座 `http://localhost:8001/docs`。
- 新增、删除或改名接口时，同一次提交里更新本文。`tests/test_api_doc.py` 会比对代码里的路由和本文表格里的 `` `方法 路径` ``，对不上测试就失败。
- 改了已有字段的含义或删了字段，在文末“变更记录”写一行；只加可选字段不用记。

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 地址 | 学习后端 `:8000`（前端只调它）；底座 `:8001`（只给学习后端和运维用，不对浏览器开放） |
| 格式 | JSON，UTF-8；时间点和时长单位都是秒（float）；时间戳 `occurred_at` 是毫秒 epoch |
| 身份 | 开发期用请求头 `X-SeeDots-User: <user_id>`，缺省为 `demo`；`<video>`、`<img>` 这类不能带请求头的地址用查询参数 `?u=`。接入托管认证后只替换 `current_user` 一处，接口不变 |
| 可见性 | 公开视频（YouTube）所有人可见；上传和网页来源只对本人可见。看不到的资源一律返回 **404**（不返回 403，不暴露存在与否） |
| 错误 | `{"detail": "..."}`。400 系列：422 参数不合法或来源不可用；404 不存在或无权；409 状态冲突（如重复合并）；401 Webhook 签名错误。502 底座不可用；503 模型暂不可用 |
| 流式 | SSE（`text/event-stream`），每条为 `event: <名>` + `data: <JSON>`；用于解析进度和 Coach |
| 证据引用 | 证据 ID 形如 `{media_id}.s0042`（句子）、`.c01`（章节）、`.k0001`（关键帧）、`.r0001`（区域），配合 `revision`。界面展示的时间一律来自证据，不来自模型 |
| 答案 | 学习项下发时不含答案；作答提交后由服务端评分并返回答案与解释 |
| 幂等 | 行为事件按 `event_id` 去重；Webhook 按 `event_id` 去重、按 `seq` 容忍乱序 |
| CORS | 学习后端允许 `SEEDOTS_WEB_ORIGINS` 里的前端来源；暴露 `Content-Range`、`Accept-Ranges` 以支持视频拖动 |

## 2. 学习后端（:8000）

### 2.1 用户与设置

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `GET /health` | 健康检查 | — | `ok`、`model`、`engine`、`selector`（`llm` / `rule`）、`embedder` |
| `GET /api/me` | 当前用户（首次访问时创建） | — | `id`、`name` |
| `GET /api/settings` | 读取设置 | — | `focus_mode`、`max_cards_per_5min`、`purpose`（`interest` / `exam` / `work` / `research`）、`language` |
| `PUT /api/settings` | 修改设置（只改传入的字段） | 同上，均可选；`max_cards_per_5min` 为 0–10 | 修改后的设置 |

### 2.2 视频

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `POST /api/videos` | 用链接添加视频。YouTube → 平台来源、公开；其他网页 → 网页来源、私有，必须带 `rights_statement` | `url`、`rights_statement?`、`priority_from?`（从哪一秒开始优先解析）、`language`（默认 `en`） | 201，视频对象（见下） |
| `POST /api/videos/upload` | 上传视频文件（multipart） | `file`、`captions?`（`.vtt` / `.srt`）、`language` | 201，视频对象 |
| `GET /api/videos` | 我的视频库，按最近打开排序 | — | 视频对象数组 |
| `GET /api/videos/{media_id}` | 单个视频状态（顺便向底座刷新） | — | 视频对象 |
| `DELETE /api/videos/{media_id}` | 从我的视频库移除（不删共享内容） | — | `ok` |
| `PUT /api/videos/{media_id}/position` | 记录续播位置 | `t` | `ok` |
| `GET /api/videos/{media_id}/progress` | **SSE**：解析与内容生成进度，约 1.5 秒推一次变化 | — | 事件 `progress`、`end`；数据为 `status`、`detail`、`chapters_total / done / failed`、`items` |
| `POST /api/videos/{media_id}/retry` | 重新生成内容失败的章节；已完成的步骤保留，从失败处继续 | — | `restarted`（重新开始的章节数） |
| `GET /api/videos/{media_id}/pack` | 学习页一次取全：播放器需要的一切，不含答案 | — | 见下方“学习包” |
| `GET /api/videos/{media_id}/file` | 我们持有的视频文件（上传、网页来源），支持 Range | `?u=` | 视频流 |
| `GET /api/videos/{media_id}/frames/{name}` | 关键帧图片（`k0001.jpg`） | `?u=` | JPEG |

**视频对象**：`media_id`、`title`、`source_kind`（`upload` / `platform` / `webpage`）、`visibility`、`duration`、`playback`（播放方式，如 YouTube 嵌入信息）、`capabilities`（`has_file`、`frames`、`native_seek`、`playback`）、`status`（`registered` → `analyzing` → `ready` / `failed`）、`status_detail`、`content`（`chapters_total`、`chapters_done`、`chapters_failed`、`items`）、`position`、`added_at`。

**学习包**（`/pack`）：

| 字段 | 内容 |
| --- | --- |
| `video` | 视频对象 |
| `chapters[]` | `id`、`t0`、`t1`、`title`、`summary`、`content_status`（`pending` / `running` / `done` / `failed`） |
| `sentences[]` | 逐句稿：`id`、`ref`（短 ID，如 `s0042`）、`t0`、`t1`、`text`、`confidence`、`needs_review` |
| `frames[]` | 关键帧：`id`、`t`、`src` |
| `concepts[]` | `id`、`name`、`occurrences[]`（`chapter_id`、`t0`、`t1`、`role`）、`elsewhere[]`（我看过的其他视频里的同一概念：`media_id`、`title`、`t0`） |
| `items[]` | 学习项（见 2.3），另加 `attempted`、`solved` |
| `marks[]` | 我的标记：`id`、`t`、`type`、`note` |
| `scenes[]` | 交互场（见 2.5） |
| `settings` | 我的设置 |

### 2.3 学习运行时

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `POST /api/events` | 批量上报行为事件（只追加，按 `event_id` 去重），一次最多 500 条 | `events[]`：`event_id`、`type` 必填；`session_id`、`media_id`、`media_time`、`client_seq`、`occurred_at`（毫秒）、`payload` 可选 | `accepted`（新写入条数） |
| `POST /api/decide` | 信号 → 教学动作 | `media_id`、`signal`（见下） | `decision_id`、`action`、`reason`、`selector`、`rule_action`、`latency_ms`、`fallback`；按动作附带 `item` / `rewatch` / `link` |
| `POST /api/decisions/{decision_id}/outcome` | 回报卡片结局 | `outcome`：`shown` / `dismissed` / `suppressed` | `ok` |
| `POST /api/attempts` | 提交作答，服务端评分并更新掌握度 | `item_id`、`response`、`assisted`（用过提示）、`confidence?`（1–5）、`decision_id?` | `correct`、`answer`、`evidence[]`（`id`、`t0`、`t1`、`text`）、`counted_toward_mastery`、`why_not_counted`、`mastery`（按概念：`level`、`streak`、`independent_correct`） |
| `POST /api/marks` | 加标记；时间点自动往前补 5 秒，挂到当时那一句 | `media_id`、`t`、`type`（`useful` / `resonate` / `confused`）、`note`（≤ 500 字） | 201，`id`、`t`（补过之后的时间）、`type`、`note` |
| `DELETE /api/marks/{mark_id}` | 删除自己的标记 | — | `ok` |
| `PATCH /api/evidence/{evidence_id}` | 纠正一句逐字稿（底座生成新 revision） | `text` | `id`、`revision`、`text` |

**信号 `signal`**：`kind`、`t`、`chapter_id?`、`concept_id?`、`detail?`。每种信号只允许一组动作，模型只能在里面选：

| `kind` | 前端何时发出 | 允许的 `action` |
| --- | --- | --- |
| `chapter_end` | 播到章节末尾 | `none`、`quiz`、`check_in`、`rewatch`、`explain` |
| `skip_ahead` | 跳过一段 | `none`、`quiz`、`check_in`、`rewatch` |
| `rewind_repeat` | 同一段回看两次 | `none`、`check_in`、`rewatch`、`explain`、`quiz` |
| `long_pause` | 长暂停 | `none`、`check_in`、`explain`、`quiz` |
| `predict_window` | 揭晓句前 25 秒内 | `none`、`predict` |
| `concept_seen_before` | 出现别的视频里学过的概念 | `none`、`link` |
| `confused_mark` | 点了“疑惑” | `explain` |
| `manual` | 用户点“Quiz me” | `quiz`；本章没有未作答的题时 `none`。和 `confused_mark` 一样由规则直接回答，不调用模型 |

动作附带的内容：`quiz` / `predict` → `item`（学习项）；`rewatch` → `rewatch`（`evidence_id`、`t0`、`t1`、`item_id`）；`link` → `link`（`id`、`concept_id`、`concept`、`occurrence_id`、`media_id`、`title`、时间）；`explain` 由前端打开 Coach。

**学习项**（下发形态）：`id`、`key`（跨版本稳定）、`version`、`type`、`schema_version`、`chapter_id`、`level`（1–3）、`concept_ids`、`concepts`、`evidence[]`（`id`、`revision`、`t0`、`t1`；不含揭晓句）、`review_status`、`show_before`（预测题必须在此时间之前出）、`payload`。

| `type` | `payload` | 作答 `response` |
| --- | --- | --- |
| `single_choice`、`find_error`、`predict` | `stem`、`options[]`（2–6）、`hints[]` | `{"index": 1}` |
| `multi_choice` | 同上 | `{"indices": [0, 2]}` |
| `ordering` | `stem`、`items[]`（已打乱）、`hints[]` | `{"order": [2, 0, 1]}`（`items` 的下标，按正确顺序） |
| `matching` | `stem`、`left[]`、`right[]`、`hints[]` | `{"pairs": [1, 0, 2]}`（`pairs[i]` 是 `left[i]` 对应的 `right` 下标） |

**前端行为事件 `type`**（目前上报的）：`play`、`pause`、`seek`、`rate`、`page_hidden`、`page_visible`、`card_shown`、`suppressed`、`scene.open`、`scene.predict`、`scene.set_param`、`scene.observe`、`scene.explain`、`scene.request`。新增类型不需要改后端，但请在这里补一行。

### 2.4 AI Coach

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `POST /api/coach` | **SSE**：基于当前时刻的回答 | `media_id`、`t`（当前播放时间）、`question`（≤ 2000 字） | 事件 `delta`（`text` 片段）、`done`（`message_id`、`citations[]`）、`error`（`message`） |
| `GET /api/coach/{media_id}` | 我在这个视频上的对话历史 | — | 消息数组，带引用 |

Coach 的回答正文是 Markdown（公式为 `\(...\)` / `\[...\]`），引用标记可能写成 `[s0042]`、`[s0063, s0069]` 或 `[s0066–s0069]`，前端与服务端按同一语法解析。

**引用 `citations[]`**：`kind` 为 `evidence` 时带 `ref`（回答正文里的标记，如 `s0042`、`o1`）、`id`、`revision`、`t0`、`t1`、`media_id`（`media_id` 不是当前视频时，就是 Coach 通过概念检索引用的其他视频）；`kind` 为 `external` 时表示视频之外的知识，界面标“not from the video”。

### 2.5 交互场

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `POST /api/scenes` | 请求生成一个 L2 交互场（异步） | `media_id`、`chapter_id`、`request`（学习者的描述，≤ 500 字） | 202，交互场对象（`status: queued`） |
| `GET /api/scenes/{scene_id}` | 交互场状态与内容（前端轮询看进度） | — | 交互场对象 |
| `GET /api/scenes/{scene_id}/runner` | L2 运行页 HTML。带 `Content-Security-Policy: sandbox allow-scripts`，前端放在 `<iframe sandbox="allow-scripts">` 里 | `?u=` | HTML |
| `GET /api/scenes/{scene_id}/preview.png` | 闸门截图 | `?u=` | PNG |

**交互场对象**：`id`、`level`（`L1` / `L2`）、`component`、`chapter_id`、`title`、`status`（`queued` / `generating` / `ready` / `failed`）、`request`、`error`、`progress`（`stage`、`log[]`）、`evidence[]`、`checks[]`（各道闸门结果，含“跳过”）、`spec`（仅 `ready` 时）。L1 的 `spec` 是组件配置（表达式、参数、预测题，不含答案）；L2 的 `spec` 是 `title`、`prompt`、`engine`、`params`、`predict`、`runner`、`preview`。

**运行页与宿主的消息协议**（`postMessage`）：场景 → 宿主 `ready`（参数声明）、`observe`（观测值）、`ack`（已应用某个参数值）、`error`；宿主 → 场景 `set_param`。宿主只信任对应 `ack` 之后的 `observe`。

### 2.6 知识地图与卡片

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `GET /api/map` | 我的知识地图 | — | `nodes[]`（`id`、`name`、`definition`、`mastery`、`videos`、`sources[]`：`media_id`、`title`、`chapter_id`、`t0`、`role`）、`edges[]`（`source`、`target`、`kind: co_taught`、`weight`：在同一章出现的次数） |
| `GET /api/concepts/{concept_id}` | 概念页 | — | `id`、`name`、`definition`、`aliases`、`misconceptions`、`occurrences`、`mastery`、`card` |
| `GET /api/search` | 搜索概念、视频时刻和卡片 | `q`（1–200 字） | `concepts[]`、`moments[]`、`cards[]` |
| `POST /api/concepts/{concept_id}/card` | 让模型起草一张知识卡（草稿，需本人确认） | — | 卡片；409 已有草稿；503 模型不可用 |
| `GET /api/cards` | 我的知识卡 | — | 卡片数组：`id`、`concept_id`、`title`、`body`、`status`、来源 |
| `PATCH /api/cards/{card_id}` | 编辑或确认卡片 | `title?`、`body?`、`status?`（`draft` / `confirmed` / `archived`） | 卡片 |
| `POST /api/links/{link_id}` | 确认或忽略一条跨视频连线 | `status`：`confirmed` / `dismissed` | `ok` |

### 2.7 审阅与运维

审阅接口给内容审阅人使用，目前没有权限区分（接入认证后加角色）。

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `POST /api/items/{item_id}/review` | 审阅学习项；只有 `human_reviewed` 的作答计入掌握 | `status`：`human_reviewed` / `rejected` / `auto_validated` / `retired`；`note` | `id`、`review_status` |
| `GET /api/review/candidates` | 待确认的概念合并候选 | — | `id`、`concept`、`suggested`、`score`、`judge` |
| `POST /api/review/candidates/{candidate_id}` | 合并或拒绝候选 | `merge` | `merge_log_id`；409 状态冲突 |
| `POST /api/review/merges/{log_id}/rollback` | 回滚一次合并 | — | `rollback_log_id` |
| `GET /api/usage` | 最近的模型调用记录 | `limit`（≤ 1000） | 任务、模型、提示词版本、token、耗时、首 token 时间、上下文清单 |
| `POST /hooks/media` | 接收底座 Webhook（见 3.3） | 底座事件，需签名 | `status`：`ok` / `duplicate`；401 签名错误 |

## 3. 视频分析底座（:8001）

只做“媒体、时间、证据”，不知道知识点和题目。

### 3.1 媒体与证据

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `GET /health` | 健康检查 | — | `ok`、`model`、`engine`、`asr` |
| `POST /v1/media` | 登记来源，默认同时开始解析 | `source`（`kind`：`upload` / `platform` / `webpage`；`uri`；网页必须带 `rights_attestation.statement`，≥ 10 字）、`visibility`、`owner`、`language`、`analyze`、`priority_from` | 201，媒体对象；422 来源不可用 |
| `POST /v1/media/upload` | 上传文件（multipart），私有 | `file`、`captions?`（`.vtt` / `.srt`）、`owner`、`language`、`analyze` | 201，媒体对象 |
| `GET /v1/media` | 列表 | `owner?`（返回公开 + 该用户私有）、`limit` | 媒体对象数组 |
| `GET /v1/media/{media_id}` | 状态 | — | 媒体对象 |
| `POST /v1/media/{media_id}/analyze` | 开始或加入解析 | `priority_from?` | 媒体对象 |
| `GET /v1/media/{media_id}/chapters` | 当前章节证据 | — | 证据单元数组 |
| `GET /v1/media/{media_id}/evidence` | 按类型和区间取当前证据 | `kinds`（默认 `sentence,chapter`）、`t0?`、`t1?` | 证据单元数组 |
| `GET /v1/evidence/{evidence_id}` | 取某个版本的证据 | `revision?`（缺省为当前） | 证据单元 |
| `PATCH /v1/evidence/{evidence_id}` | 纠正一句，生成新 revision 并发出 `media.evidence_revised` | `text`、`by` | 证据单元 |
| `GET /v1/media/{media_id}/file` | 持有的文件 | — | 文件 |
| `GET /v1/media/{media_id}/frames/{name}` | 关键帧 | `name` 形如 `k0001.jpg` | JPEG |
| `GET /v1/usage` | 模型调用记录 | `limit` | 同学习后端 |

**媒体对象**：`id`、`source_kind`、`source_uri`、`platform`、`external_id`、`visibility`、`owner`、`language`、`title`、`duration`、`capabilities`、`status`、`status_detail`、`platform_meta`（`video_id`、`channel`、`chapters`）、`stages[]`（`stage`、`version`、`status`、`error`、`attempts`、`stats`）、`job`。

**证据单元**（`EvidenceUnit`，`common/contracts.py`）：`id`、`media_id`、`revision`、`t0`、`t1`、`kind`（`sentence` / `chapter` / `keyframe` / `region`）、`content`（句子 `{text}`；章节 `{title, summary, sentence_ids}`；关键帧 `{caption?}`；区域 `{text, label}`）、`bbox?`、`frame_ref?`、`source`、`processor`（`名字@版本`）、`confidence`、`needs_review`。

### 3.2 事件与 Webhook

| 接口 | 用途 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `GET /v1/events` | 拉取事件（Webhook 的兜底） | `media_id?`、`after_seq`、`limit` | 事件数组，按 `seq` 升序 |
| `POST /v1/events/{event_id}/replay` | 重放事件（死信处理） | `subscription_id?` | `queued` |
| `GET /v1/deliveries` | 投递记录 | `status?`：`pending` / `delivered` / `dead` | `event_id`、`subscription_id`、`type`、`media_id`、`status`、`attempts`、`last_error` |
| `POST /v1/webhooks` | 订阅 | `url`、`secret`（≥ 8 字）、`event_types[]`（空 = 全部） | 201，`id` |
| `GET /v1/webhooks` | 订阅列表 | — | `id`、`url`、`event_types`、`active` |
| `DELETE /v1/webhooks/{sub_id}` | 停用订阅 | — | `ok` |

### 3.3 事件契约

```json
{"event_id": "evt_…", "type": "media.chapter_ready", "media_id": "med_…", "seq": 7,
 "occurred_at": 1760950000000,
 "data": {"chapter_id": "med_….c02", "revision": 1, "t0": 312.4, "t1": 655.0, "title": "…"}}
```

| `type` | 何时发出 |
| --- | --- |
| `media.registered` | 登记完成 |
| `media.outline_ready` | 章节边界确定 |
| `media.chapter_ready` | 某一章的证据可用（按“播放位置往后优先”逐章发出） |
| `media.evidence_revised` | 证据被纠正，产生新 revision |
| `media.analysis_completed` | 全部步骤完成 |
| `media.failed` | 解析失败，`data` 里有原因 |

- **签名**：请求头 `X-SeeDots-Signature` = 请求体的 HMAC-SHA256（hex），密钥是订阅时的 `secret`。
- **投递**：发件箱与状态变化同一事务提交；失败指数退避，12 次后进入 `dead`，可用 replay 重放。
- **消费方要求**：按 `event_id` 幂等；不信任事件体里的状态，收到后回拉 `GET /v1/media/{id}`；按 `seq` 容忍乱序和重复。

## 变更记录

| 日期 | 修改 |
| --- | --- |
| 2026-10-20 | 新增 `POST /api/videos/{media_id}/retry`；`manual` 信号只返回 `quiz` / `none`；Coach 正文为 Markdown，引用标记支持分组与区间 |
| 2026-10-20 | v1.0：首版，覆盖学习后端 40 个、底座 19 个接口；`POST /api/marks` 的时间点往前补 5 秒 |
