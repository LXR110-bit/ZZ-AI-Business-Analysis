# AI 小万 v1.5.5 zloop 迁移计划

## 1. 版本目标

v1.5.5 是 AI 小万从旧服务器日更链路迁移到 zloop 的**并行验证版本**，目标是先把旧链路的取数、处理、分析、校验能力拆成可审计的 zloop 四阶段产物，再由服务器主动拉取用于展示预览和飞书 AI 摘要卡 dry-run。

本版本**不立刻替换线上**：旧服务器日更链路继续正式展示和正式推送；新 zloop 链路只生成产物、校验报告、服务器预览缓存和 outbox。

```text
旧服务器日更链路
  → zloop 4 Skill + 4 Loop
  → 服务器主动拉取 zloop 产物
  → 服务器展示预览 + 飞书 AI 摘要卡 dry-run/outbox
  → gitclaw 同步
```

## 2. 架构决策

### 2.1 正式采用 4 Skill + 4 Loop

v1.5.5 正式方案为四阶段流水线；历史讨论中的 `2 Skill + 2 Loop` 只作为已废弃草案，不再作为实现口径。

| 顺序 | 阶段 | Loop | Skill | 核心职责 | LLM 边界 |
| ---: | --- | --- | --- | --- | --- |
| 1 | Fetch | `zloop-loops/ai-wan-fetch-loop.md` | 小万经营取数 | 跑 6 份 Hive SQL，输出 raw_cache/sql_status/raw_manifest/active_fetch_manifest | 禁止调用 |
| 2 | Process | `zloop-loops/ai-wan-process-loop.md` | 小万数据处理 | 表头规范化、Sheet5 model 口径、day_cnt 周日均、rolling/final、10 周 history、server_cache_bundle、analysis_history、标签快照 | 禁止调用 |
| 3 | Analyze | `zloop-loops/ai-wan-analyze-loop.md` | 小万经营分析 | 基于 analysis_history/model_tag_knowledge 先生成 evidence_pack，再产出 insights/summary/review_notes/analysis_trace | 仅 `GLM-5.2` 与 `DeepSeek V4 Pro` |
| 4 | Validate | `zloop-loops/ai-wan-validate-loop.md` | 小万经营校验 | 校验数据质量、history、evidence_id、schema、known_gap、LLM 白名单、过度归因、输出安全，生成 final_status | 规则为主；如做语义复核也仅限两模型 |

每个 Loop 只绑定一个 Skill。Loop 的调度时间只作兜底，真实依赖必须由 active manifest 串联。

### 2.2 active manifest 串联机制

每个阶段都写出一个 active manifest：

```text
active_fetch_manifest.json
active_process_manifest.json
active_analysis_manifest.json
active_validation_manifest.json
```

下游必须校验以下字段，不允许因为文件名存在就继续：

- `contract_version`
- `stage`
- `status`
- `run_id`
- `run_dt`
- `upstream_stage`
- `upstream_run_id`
- `artifact_hashes` / `sha256`
- 产物路径或云盘链接

失败策略：上游缺失、失败、run_dt 不一致、run_id 断链、sha256 不一致时，下游必须停止或输出 failed/warn，不允许静默读取上一轮旧产物。

## 3. zloop 与服务器职责边界

### zloop 负责

- 执行 Hive SQL 并生成 raw_cache；
- 将 raw_cache 处理成 imports、Excel、processed_cache；
- 复制旧服务器数据处理能力：表头规范化、逗号机型名修复、Sheet5 model 粒度、周日均、rolling/final、10 周 history；
- 生成 `server_cache_bundle_<run_dt>.zip` 供服务器消费；
- 生成 `analysis_history_<run_dt>.json`、`evidence_pack_<run_dt>.json`、`insights_<run_dt>.json`；
- 生成 `data_quality_report`、`validation_report`、`final_status`；
- 生成 `model_tag_snapshot` 与 `model_tag_knowledge`。

### 服务器负责

- 主动读取 zloop active manifest；
- 拉取 `server_cache_bundle`、`insights`、`summary`、`validation_report`、`final_status`；
- 校验 sha256 后更新本地 dashboard cache 或预览目录；
- 页面展示、access code 与权限控制；
- 基于现有 `tools/feishu_push/send_card.py`、`lark-cli bot` / webhook 构建并发送卡片；
- v1.5.5 首版只把新 AI 摘要卡写入 outbox，不自动正式推送。

服务器不调用 LLM，不直接生成经营洞察。

## 4. 旧服务器能力映射

| 旧服务器能力 | v1.5.5 迁移落点 | 备注 |
| --- | --- | --- |
| `local-imports` / Hive 取数 | Fetch Skill | 只产 raw，不做处理 |
| `validate-daily-import-coverage.js` | Process + Validate | Process 产出质量报告，Validate 最终裁决 |
| `check-wtd-quality.js` | Process + Validate | WTD/day_cnt/rolling 校验 |
| `promote-local-imports.js` | Process Skill | 分区覆盖与 final 冻结 |
| `src/category-sync.js` / `src/sync.js` | Process Skill | 生成 category/model cache 与指标派生 |
| `sync-board-metrics-from-feishu.js` | Process known_gap / 后续补齐项 | 当前缺口不能写成确定性结论 |
| `generate-business-overview-insights.js` | Analyze Skill | 证据包优先，LLM 只读 evidence |
| `check-ai-insights-quality.js` | Validate Skill | evidence/schema/over-attribution/known_gap |
| `build-weekly-card-payload.js` / `send_card.py` | 服务器保留；新增 AI 摘要卡 dry-run | 旧 `monitor_weekly` 正式推送不受影响 |

## 5. LLM 使用边界

- Fetch / Process：全程禁止调用 LLM。
- Analyze / Validate：只允许 `GLM-5.2` 和 `DeepSeek V4 Pro`。
- 禁止 fallback 到任何第三模型。
- daily 模式：`GLM-5.2` 主生成，`DeepSeek V4 Pro` 复核。
- deep_dive 模式：`DeepSeek V4 Pro` 深挖，`GLM-5.2` 结构化。
- 模型不可用时必须写入 trace 并降级/失败，不能悄悄换模型。

## 6. 飞书推送策略

v1.5.5 保持旧链路正式推送，新链路只 dry-run：

- 旧 `monitor_weekly`：继续正式推送；
- 新 `ai_business_summary`：只生成 payload、校验、写 outbox；
- 新卡片必须包含四层摘要：大盘、品类、机型、履约；
- 新卡片不得泄漏技术字段、内部 manifest 路径、模型 trace；
- 只有 owner 后续人工确认后，才允许切换为正式推送。

## 7. 机型标签 / 分层同步策略

v1.5.5 首版 source of truth 仍是服务器前端打标结果：

```text
model-tag-monitor/data/tags.json
model-tag-monitor/data/tag-vocab.json
model-tag-monitor/data/rules.json
```

Process 每日拉取并规范化三类文件，生成：

```text
model_tag_snapshot_<run_dt>.json
model_tag_knowledge_<run_dt>.json
model_tag_feishu_summary_<run_dt>.md
model_tag_sync_manifest_<run_dt>.json
```

同步原则：

- zloop Analyze 只读 `model_tag_knowledge`；
- Validate 校验标签快照 sha、覆盖率和 evidence 回链；
- 飞书知识库只展示摘要和附件链接，不作为首版 source of truth；
- 配置 `FEISHU_KNOWLEDGE_DOC` 后由 exporter 覆盖写入飞书 Wiki/Doc 摘要页；
- 飞书未配置/同步失败只写 `feishu_knowledge_summary_sync_*` known_gap，不阻塞 Analyze 数据包生成。

## 8. 并行 dry-run 上线策略

1. 旧服务器日更照常跑，保持正式 dashboard 和正式飞书推送。
2. zloop 四阶段按 active manifest 串联独立运行。
3. 服务器从 Validate 通过或 warn 的产物中拉取 bundle 做预览。
4. AI 摘要卡只写 outbox，人工抽查数据、洞察和卡片展示。
5. 连续多日对齐后，再规划 v1.5.6/1.6.0 的正式切换；v1.5.5 不自动切换。

## 9. gitclaw 同步范围

目标分支：

```text
codex/server-migration-20260714
```

远端：

```text
origin = https://gitclaw.zhuanspirit.com/lixiaoran03/ai_wxjyfx.git
```

同步范围：

- `docs/AI小万_v1.5.5_*.md`
- `zloop-skills/ai-wan-*`
- `zloop-loops/ai-wan-*.md`
- 服务器拉取 / AI 卡片 dry-run 相关脚本与模板
- 标签快照导出脚本与测试

不自动打 tag；`v1.5.5` tag 由 owner 确认后再发。
