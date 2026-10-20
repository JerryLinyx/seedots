# SeeDots

See the dots. Connect them. 给正在看的教学视频加一层 AI：在恰当的时刻出现可验证的学习动作，答案指回视频里的具体时刻，并把不同视频里的知识连起来。

按《Trace 技术方案 v1.1》实现：通用视频分析底座 → 学习内容生成 → 学习运行时 → AI Coach → 知识地图。

## 结构

```
apps/web/                    Next.js 前端（只做前端，业务全部走学习后端）
  components/DotRail.tsx     视频时间线：章节、概念、标记、播放头
  lib/policy.ts              介入策略（何时可以打扰：自然停顿、频率、专注模式、连续忽略静音）
services/
  seedots/common/            跨服务内核
    contracts.py             证据单元、事件信封、签名
    db.py                    SQLAlchemy 内核（命名规则、可移植枚举、JSON/JSONB、UoW）
    llm/                     Pydantic AI 网关：提示词版本、类型化输出、修复重试、缓存、预算、usage_logs
    workflow.py, temporal.py 工作流端口：进程内引擎 / 通用 Temporal 工作流，跑同一套步骤
  seedots/media/             视频分析底座（独立服务 :8001，领域无关）
    sources.py               来源：上传 / YouTube（只读字幕，不下载）/ 网页（grabber + 权利声明）
    processors.py            可插拔处理器：fetch → transcript(字幕或 ASR) → outline → publish → keyframes
    webhooks.py              订阅、签名投递、退避、死信、重放；/v1/events 拉取兜底
  seedots/learning/          学习后端（:8000）
    catalog.py               视频镜像、章节、证据快照、收件箱（幂等、乱序容忍）
    concepts.py              全局概念库：精确匹配 → 向量召回 + 模型判定 → 待审候选；合并与回滚
    pipeline.py              每章：快照 → 概念 → 题目池 → 补缺
    runtime.py               按信号限定候选动作；模型优先、规则兜底并全量记录；评分与掌握度
    coach.py                 预构建上下文 + 白名单工具（本视频上下文、跨视频概念检索）+ 证据引用
    knowledge.py             知识地图、概念页、知识卡片（草稿→用户确认）、搜索
  grabber/                   网页视频抓取（来自 Kiwi/mediagrab，Node）
  migrations/                Alembic，每个服务一套
docs/database.md             数据库设计
```

## 快速开始（macOS）

需要 Python 3.11+、Node 20+、ffmpeg。

```bash
git pull                         # 在 ~/workSpace/seedots
cp .env.example .env             # 填 SEEDOTS_LLM_API_KEY；没有密钥时把 SEEDOTS_LLM_FAKE 设为 1
cd services && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..
cd apps/web && npm install && cd ..
(cd services/grabber && npm install)   # 可选：要从网页添加视频时需要
scripts/dev.sh                   # 底座 :8001，学习后端 :8000，前端 :3000
```

打开 http://localhost:3000 。首页已填好示例 YouTube 链接；也可以上传自己的视频（字幕可选，没有字幕时需要配置 `SEEDOTS_ASR_MODEL`）。

测试（离线，不需要密钥）：

```bash
cd services && .venv/bin/python -m pytest
```

## 模型

所有模型调用都经过 `common/llm`（Pydantic AI）。默认走 TokenRouter 的 OpenAI 兼容接口，模型 `deepseek/deepseek-v4-flash-0731`。`GET /api/usage`、`GET /v1/usage` 可以看到每次调用的任务、提示词版本、token、延迟和上下文清单。提示词在各服务的 `prompts/<task>.v<N>.md`，改提示词 = 新增版本。

可选能力：

- `SEEDOTS_EMBED_MODEL`：概念召回用的向量模型（不配则用本地字面相似度，只能识别拼写变体）。
- `SEEDOTS_ASR_MODEL`：没有字幕的上传 / 网页视频走语音识别（OpenAI 兼容 `/audio/transcriptions`）。
- `SEEDOTS_WORKFLOW_ENGINE=temporal`：用 Temporal 跑工作流（`pip install -e '.[temporal]'`，再分别启动 `python -m seedots.common.temporal media|learning`）。
- `SEEDOTS_*_DB_URL`：换成 PostgreSQL（`pip install -e '.[postgres]'`）。

## 和技术方案的差异（有意的，后续替换）

| 方案 | 现在 | 下一步 |
| --- | --- | --- |
| YouTube：模型直读链接 + 第二遍画面证据 | 只读平台字幕轨；关键帧只对自有文件生成 | 接视觉模型后增加区域证据处理器 |
| L1 / L2 交互场 | 只有数据表（`scene_specs`） | Trace Scene Kit + SceneSpec |
| 托管认证 | 请求头 `X-SeeDots-User`（默认 `demo`） | 接认证服务，`current_user` 一处替换 |
| pgvector | 向量存 JSON，召回在应用里算 | 见 `docs/database.md` |
| 评测平台 / 金标集 | 未做 | 20 个视频金标 + 校准过的模型裁判 |

Temporal 适配层和 OpenAI 兼容模型这两条路径在本仓库的离线测试里没有运行（测试环境没有 Temporal 服务和外网），首次在本机启用时请留意日志。

## 设计约束（不要破坏）

1. 时间只有一个来源：模型只引用证据 ID（如 `s0042`），不输出秒数。
2. 在线只查表：出卡片时不现场生成题目；模型只在 Coach 和动作选择里实时调用。
3. 事实由代码算：评分在服务端；自动校验通过的学习项可以用，但只有人工审过的才计入掌握。
4. YouTube 只用官方嵌入播放器，不遮挡、不修改、不下载视频。
