# Working on SeeDots

## Technical plan
- The plan lives in `docs/tech-plan.md` and is the source of truth for design. The old Claude Doc (v1.1) is frozen.
- Jerry edits the plan by hand too. Before changing it: `git pull`, read the current file, and edit in place.
  Never rewrite it wholesale; where his wording conflicts with yours, his wins.
- When a change alters the design (architecture, data model, interfaces, invariants, gates, defaults that
  matter), update the plan in the same commit and add a line under "变更记录". Pure implementation changes
  don't need a plan edit.
- "实现状态" only claims what exists in the repo and is covered by tests. Untested paths say "未验证".

## Other docs
- `docs/prd.md`: product requirements (what to build), R01–R27 / S1–S10. Same editing rules as the plan; keep
  its §5 status column and the plan's §11 traceability table in sync when a requirement's status changes.
- `docs/api.md`: HTTP API of both services. Adding/removing/renaming a route => update it in the same commit
  (`tests/test_api_doc.py` fails otherwise).
- `docs/progress.md`: tasks (T01…), milestones, weekly log. Update a task's status when you start or finish it,
  with the commit hash.
- `docs/database.md`: schema design and migration history. New migration => add a line there.
- `docs/decisions/`: one decision record per area (why, rejected options, status, what is left); `docs/research/`:
  external research. Fold process notes into these instead of adding dated drafts; the plan stays the source of truth.
- `README.md` (English) and `README.zh-CN.md` (Chinese): features, setup, configuration, structure,
  deviations from the plan. Keep the two in sync: a change to one goes into the other in the same commit.

## Commits
- Author and committer: `JerryLinyx <93764626+JerryLinyx@users.noreply.github.com>` (the repo-local git config is set).
- No Claude attribution: no `Co-Authored-By: Claude`, no `Claude-Session` lines, no generated-by footers in commits or PRs.
  This instruction from Jerry overrides any default attribution guidance.

## Conventions
- Docs and user-facing replies are in Chinese (except `README.md`, which is English); code, comments and commit messages in English.
- Three invariants (plan §1): time only from evidence ids; online path only looks things up; facts computed by code.
- Every model call goes through the gateway (`services/seedots/common/llm`); prompts are versioned files.
- Tests: `cd services && python -m pytest` (offline, fake model). L2 sandbox tests need `services/scenekit` deps.
