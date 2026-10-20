# SeeDots

See the dots. Connect them. 给正在看的教学视频加一层 AI：在恰当的时刻出现可验证的学习动作，并把不同视频里的知识连起来。

本仓库是按《Trace 技术方案 v1.1》搭的第一个可运行 demo，覆盖 11/9 切片：视频分析底座（第一遍解析）→ 学习内容生成（概念、学习项池）→ 学习运行时（介入策略、动作选择、评分）→ AI Coach。

## 结构

```
apps/web/                 Next.js 前端（只做前端，业务全部走学习后端）
services/seedots/
  common/                 跨服务契约（证据单元、事件信封、签名）、LLM Gateway、sqlite 封装
  media/                  视频分析底座（独立服务，:8001）
    sources.py            来源适配器：上传 / YouTube（官方嵌入 + 字幕轨）/ 网页（占位）
    captions.py           VTT/SRT 解析、YouTube 滚动字幕去重、断句
    processors.py         逐句证据、章节大纲（模型输出只引用句子 ID）
    service.py            分阶段、幂等的解析流程；按播放位置排章节优先级
    webhooks.py           outbox + 签名 Webhook，失败重试、可人工重放
  learning/               学习后端（:8000）
    pipeline.py           每章：概念抽取与归一 → 学习项生成 → 校验 → 发布
    item_types.py         题型注册表（payload / 答案 / 校验 / 评分）
    runtime.py            动作选择（模型优先、出错回退规则，规则每次都记录）、评分、掌握状态
    coach.py              有据可查的流式 Coach（引用 [s0042] → 时间点）
    prompts/              按任务、按版本存放的提示词
services/tests/           离线测试（假模型，无需密钥）
```

## 快速开始（macOS）

需要 Python 3.11+、Node 20+、ffmpeg（可选）。

```bash
cp .env.example .env            # 填 SEEDOTS_LLM_API_KEY；没有密钥时把 SEEDOTS_LLM_FAKE 设为 1
cd services && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..
cd apps/web && npm install && cd ..
scripts/dev.sh                  # 底座 :8001，学习后端 :8000，前端 :3000
```

打开 http://localhost:3000 ，粘贴 YouTube 链接（默认填好了一个示例）。页面会依次显示：解析字幕 → 生成大纲 → 按章节生成学习内容。学习页里可以边看边标记、提问，章节结束、反复回看、长时间暂停时右侧会出现卡片。

测试：

```bash
cd services && .venv/bin/python -m pytest      # 或 python -m unittest discover -s tests -t .
```

## 模型

所有模型调用都经过 `common/llm.py` 的 Gateway：按任务绑定提示词版本、JSON 输出 + Pydantic 校验 + 一次修复重试、结果缓存、`usage_logs`（`GET /api/usage` 可看）。默认走 TokenRouter 的 OpenAI 兼容接口，模型 `deepseek/deepseek-v4-flash-0731`（纯文本）。

- 如果 TokenRouter 控制台给的 Base URL 和 `.env.example` 不一样，以控制台为准。
- `SEEDOTS_LLM_FAKE=1` 时用离线假模型，只用来跑通流程，题目质量没有意义。

## 和技术方案的差异（有意的，后续替换）

| 方案 | 本 demo | 原因 / 下一步 |
| --- | --- | --- |
| Temporal 编排 | 进程内 worker + 阶段表（按 媒体·阶段·处理器版本 幂等） | 阶段契约不变，后续每个阶段搬进 Activity |
| PostgreSQL + pgvector | sqlite（每个服务一个库） | 表结构按三层设计，迁移不改模型 |
| Pydantic AI | Gateway 直连 OpenAI 兼容接口 | 先保证 DeepSeek 的 JSON 模式稳定；Gateway 边界保持类型化输入输出，换 Pydantic AI 只改传输层 |
| 概念归一：向量召回 + 模型判定 | 名称 / 别名规范化匹配 | 接 embedding 后替换 `concept_by_norm` |
| YouTube：模型直读链接 | 读平台字幕轨（只取字幕，不下载视频） | DeepSeek 不能看视频；接 Gemini（TokenRouter 有 gemini 格式）后改成直读链接，并补第二遍画面/区域证据 |
| 第二遍解析（关键帧、公式、区域） | 未做 | 需要视觉模型 |
| L1 / L2 交互场 | 未做 | 下一步：Trace Scene Kit + SceneSpec |
| 网页视频（mediagrab） | 适配器占位 | 接入 Kiwi/mediagrab，作为 WebPage 适配器 |
| 身份 | 固定用户 `demo` | 接托管认证服务 |

## 设计约束（不要破坏）

1. 时间只有一个来源：模型只引用证据 ID（如 `s0042`），不输出秒数。
2. 在线只查表：出卡片不现场生成题目；模型只在 Coach 和动作选择里实时调用。
3. 事实由代码算：评分在服务端；自动校验通过的学习项可以给用户用，但只有人工审过（`POST /api/items/{id}/review`）的才计入掌握。
4. YouTube 只用官方嵌入播放器，不遮挡、不修改、不下载视频。
