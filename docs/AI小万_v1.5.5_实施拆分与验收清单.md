# AI 小万 v1.5.5 实施拆分与验收清单

## 1. 多 Agent 分工

| Agent | 当前会话 / 线程 | 负责范围 | 交付物 |
| --- | --- | --- | --- |
| A 总架构文档 | 当前主控会话 | 固化 v1.5.5 总迁移计划、四阶段产物契约、验收清单；清理 2 Skill + 2 Loop 旧口径 | `docs/AI小万_v1.5.5_zloop迁移计划.md`、`docs/AI小万_v1.5.5_四阶段产物契约.md`、本清单 |
| B 数据链路 | `019f64fb-f520-7b30-bca9-52442043ceac` | Fetch + Process：取数、表头/Sheet5/day_cnt/rolling/final/10 周 history、server_cache_bundle、analysis_history、data_quality_report | `zloop-skills/ai-wan-data-fetch/**`、`zloop-skills/ai-wan-data-process/**`、`zloop-loops/ai-wan-fetch-loop.md`、`zloop-loops/ai-wan-process-loop.md`、`docs/AI小万_v1.5.5_数据处理契约.md` |
| C 分析校验 | `019f64fc-1f58-7ce1-bef2-cb19ae494430` | Analyze + Validate：evidence_pack、GLM/DeepSeek 分析、review、validation_report、final_status | `zloop-skills/ai-wan-business-analyze/**`、`zloop-skills/ai-wan-business-validate/**`、`zloop-loops/ai-wan-analyze-loop.md`、`zloop-loops/ai-wan-validate-loop.md`、`docs/AI小万_v1.5.5_分析校验契约.md` |
| D AI 摘要卡片 | `019f64fc-38a9-7b71-adf3-44470aa2a541` | 服务器主动消费 zloop 产物、AI 摘要 payload builder/checker/card template、outbox/dry-run；不影响旧 `monitor_weekly` | `model-tag-monitor/scripts/build-ai-business-card-payload.js`、`check-ai-business-card-payload.js`、`tools/feishu_push/card_templates/ai_business_summary*.json`、测试、方案文档 |
| E 机型标签同步 | `019f64fc-543f-7441-950a-df29cf004c6a` | 服务器标签/分层盘点、导出 snapshot/knowledge/飞书摘要；Process 每日拉取，Analyze 只读消费 | `model-tag-monitor/scripts/export-model-tag-snapshot.js`、`model-tag-monitor/test/model-tag-snapshot.test.js`、`docs/AI小万_v1.5.5_知识库与机型分层迁移盘点.md` |
| F 集成总控 | 当前主控会话 | 合并所有 Agent 产物、一致性检查、package-check、Node 测试、git diff、commit/push 准备 | 集成校验结果、最终 handoff、必要的契约修正 |

> 总控原则：不覆盖 B/C/D/E 线程的核心实现；只修正跨文档、manifest、Loop 命名和验收口径不一致的问题。

## 2. 当前版本范围

v1.5.5 做：

- 4 Skill + 4 Loop；
- active manifest 串联；
- `server_cache_bundle`；
- `analysis_history`；
- `model_tag_snapshot` / `model_tag_knowledge`；
- `validation_report` / `final_status`；
- AI 摘要卡 dry-run/outbox；
- gitclaw 同步准备。

v1.5.5 不做：

- 不替换旧正式链路；
- 不让 zloop 直接发飞书；
- 不自动发布 dashboard；
- 不把飞书知识库立即设为 source of truth；
- 不自动正式推送 AI 摘要卡；
- 不使用 `GLM-5.2` / `DeepSeek V4 Pro` 之外的模型；
- 不自动打 git tag。

## 3. 第一轮验收清单

### A 总架构文档

- [x] 明确 v1.5.5 正式采用 4 Skill + 4 Loop。
- [x] 明确 2 Skill + 2 Loop 是历史方案。
- [x] 明确 active manifest 机制和 run_id/run_dt/sha256 串联。
- [x] 明确旧链路继续正式运行，新链路并行 dry-run。
- [x] 明确服务器负责展示/access code/飞书发送，zloop 不直接推飞书。
- [x] 明确 gitclaw 分支和同步范围。

### B 数据链路

- [ ] Fetch 只产出 `raw_cache` / `sql_status` / `raw_manifest` / `active_fetch_manifest`。
- [ ] Process 产出 `imports` / Excel / `manifest`。
- [ ] Process 产出 `processed_cache` / `server_cache_bundle` / `analysis_history` / `data_quality_report`。
- [ ] Process 覆盖表头规范化、Sheet5 model、逗号机型名修复。
- [ ] Process 覆盖 day_cnt 周日均、rolling 当前周覆盖、final 周冻结。
- [x] Process 保留最近 10 周 history，并通过 `history_weeks_available` + `analysis_scope_hint` 标记是否只能 `wow_only`。
- [x] Process 接入 `model_tag_snapshot` / `model_tag_knowledge` / `model_tag_sync_manifest`。（已接收 B/E handoff；真实 xinghe/API replay 待做）
- [ ] Fetch / Process manifest 和 SKILL 明确禁止 LLM。

### C 分析校验

- [x] Analyze 先生成 `evidence_pack`，再调用 LLM。
- [x] daily 模式为 GLM-5.2 主生成、DeepSeek V4 Pro 复核。
- [x] deep_dive 模式为 DeepSeek V4 Pro 深挖、GLM-5.2 结构化。
- [x] 每条 insight 必须有 `evidence_id`，且 evidence 存在。
- [x] `effective_history_weeks < 8` 时降级为 `wow_only`。
- [x] Validate 输出 `validation_report` / `final_status` / `active_validation_manifest`。
- [x] Validate 校验 LLM 白名单、known_gap、过度归因、核心机型遗漏、高严重度异常遗漏和输出安全。

### D 服务器与 AI 摘要卡

- [x] 服务器旁路入口可复制/拉取 zloop 标准产物目录并生成 outbox。
- [x] 服务器校验 payload 质量后才写 dry-run outbox。
- [x] 旧 `monitor_weekly` 正式推送不受影响。
- [x] 新 `ai_business_summary` payload 可生成。
- [x] 新卡片包含四层摘要：大盘、品类、机型、履约。
- [x] 新卡片首版只写 outbox/dry-run，不正式推送。
- [x] payload checker 校验 known_gap、URL、技术字段泄漏、final_status、`publish_allowed/push_allowed`。
- [ ] 服务器需确定真实 zloop 产物稳定目录或 `ZLOOP_ARTIFACT_PULL_CMD` hook。

### E 标签 / 知识同步

- [x] 盘点服务器 `tags.json` / `tag-vocab.json` / `rules.json`。
- [x] 导出 `model_tag_snapshot_<run_dt>.json`。
- [x] 导出 `model_tag_knowledge_<run_dt>.json`。
- [x] 导出 `model_tag_sync_manifest_<run_dt>.json`。
- [x] 导出飞书知识库摘要 Markdown。
- [x] Analyze 可按 `category||model_name` 使用标签增强。
- [x] 飞书同步失败只标 warn，不阻塞数据包生成。
- [x] 服务器仍是 v1.5.5 source of truth。
- [x] Process Loop 真实 runner 已把 `model_tag_sync_manifest` 字段、sha256 与 `artifact_hashes` 合并进 `active_process_manifest`。

## 4. 总控集成验收

### 命名 / 契约一致性

- [ ] 4 个 Skill 目录存在：`ai-wan-data-fetch`、`ai-wan-data-process`、`ai-wan-business-analyze`、`ai-wan-business-validate`。
- [ ] 4 个 Loop 文档存在，且每个只绑定一个 Skill。
- [ ] Skill frontmatter 名称与 Loop 绑定名称一致。
- [ ] manifest outputs 覆盖四阶段契约中的核心产物。
- [ ] `active_*_manifest.json` 字段包含 run_id/run_dt/upstream/sha256。
- [ ] 文档、Skill、Loop 中无“v1.5.5 采用 2 Skill + 2 Loop”的当前口径。

### 本地命令

```bash
# 4 个 zloop Skill 静态校验
zloop skill-forge package-check zloop-skills/ai-wan-data-fetch
zloop skill-forge package-check zloop-skills/ai-wan-data-process
zloop skill-forge package-check zloop-skills/ai-wan-business-analyze
zloop skill-forge package-check zloop-skills/ai-wan-business-validate

# Node 单测；如果全量过慢，可先跑新增相关测试
cd model-tag-monitor
npm test
```

### Git / 发布

- [ ] diff 只包含 v1.5.5 相关文件。
- [ ] `.DS_Store`、outbox、真实生产数据不入库。
- [ ] package-check 全部通过。
- [ ] Node 测试通过；未通过则列出失败原因和阻塞 owner。
- [ ] commit 后 push 到 `origin/codex/server-migration-20260714`。
- [ ] 不自动打 tag。

## 5. 最终交接模板

```text
Goal
- AI 小万 v1.5.5 zloop 并行 dry-run 迁移：4 Skill + 4 Loop + 服务器拉取 + AI 摘要卡 outbox。

Files Changed
- docs/...
- zloop-skills/...
- zloop-loops/...
- model-tag-monitor/scripts/...
- tools/feishu_push/card_templates/...

Validation
- zloop package-check: ...
- Node tests: ...
- Manual contract checks: ...

Known Gaps
- ...

Next Steps
- owner 确认是否上传/应用 Skill。
- owner 确认是否创建/更新 Loop。
- 连续 dry-run 对齐后，再规划正式切换。
```

## 6. 当前总控校验记录（2026-07-15 17:00）

已在本地完成以下只读/静态校验：

| 校验项 | 命令 | 结果 |
| --- | --- | --- |
| Fetch Skill package-check | `zloop skill-forge package-check zloop-skills/ai-wan-data-fetch` | 通过，0 warning |
| Process Skill package-check | `zloop skill-forge package-check zloop-skills/ai-wan-data-process` | 通过，0 warning |
| Analyze Skill package-check | `zloop skill-forge package-check zloop-skills/ai-wan-business-analyze` | 通过，0 warning |
| Validate Skill package-check | `zloop skill-forge package-check zloop-skills/ai-wan-business-validate` | 通过，0 warning |
| model-tag-monitor 全量 Node 测试 | `cd model-tag-monitor && npm test` | 通过，177/177 |

总控已修正的跨 Agent 一致性问题：

- 将工作包字母重新对齐用户拆分：B=Fetch+Process，C=Analyze+Validate，D=AI 摘要卡，E=标签同步，F=集成总控。
- 将四个已开可见会话 ID 写入分工表。
- 补齐 `ai-wan-data-process/skill.manifest.json` 的标签快照相关 outputs。
- 补齐 Analyze / Validate Skill manifest 的 inputs、outputs、checks、降级策略等 contract metadata。
- 重新生成 4 个 Skill 的 `.zip` 与 `-v0.1.0.zip` 包，保证 zip 内 manifest 与目录一致。


## 7. B/E handoff 接收记录（2026-07-15 17:12）

### B Fetch + Process 数据链路

已接收 handoff 并复核：

- Fetch 接口：`node zloop-skills/ai-wan-data-fetch/bin/package-raw-cache.js --run-dt YYYY-MM-DD --input-dir /path/to/xinghe_exports --out-dir /path/to/fetch_artifacts`。
- Process 接口：`node zloop-skills/ai-wan-data-process/bin/process-raw-cache.js --run-dt YYYY-MM-DD --input-dir /path/to/fetch_artifacts --out-dir /path/to/process_artifacts --snapshot-dir /path/to/server_snapshots [--previous-processed-cache /path/to/processed_cache_prev.zip]`。
- 本地复核通过：`node --test zloop-skills/ai-wan-data-fetch/test/package-raw-cache.test.js zloop-skills/ai-wan-data-process/test/process-pipeline.test.js`，2/2 pass。
- 本地复核通过：`zloop skill-forge package-check zloop-skills/ai-wan-data-fetch` 与 `zloop skill-forge package-check zloop-skills/ai-wan-data-process`，均 0 warning。
- 本地复核通过：`unzip -tq` 检查 `ai-wan-data-fetch.zip`、`ai-wan-data-fetch-v0.1.2.zip`、`ai-wan-data-process.zip`、`ai-wan-data-process-v0.1.2.zip`。

待真实环境验证：

- 用真实 xinghe raw export 回放多 sheet / 逗号机型名 / model CSV 边界。
- 用上一版真实 `processed_cache` 回放 history merge、final freeze、WTD 阈值。

### E 机型标签 / 分层同步

已接收 handoff 并复核：

- 标签导出接口：`npm run export:model-tags -- --source api --api-base "$MODEL_TAG_API_BASE" --access-code "$MODEL_TAG_ACCESS_CODE" --allow-file-fallback --fallback-data-dir model-tag-monitor/data --feishu-doc "$FEISHU_KNOWLEDGE_DOC" --out-dir "$PROCESS_ARTIFACT_DIR" --run-dt "$RUN_DT"`。
- 输出：`model_tag_snapshot_<run_dt>.json`、`model_tag_knowledge_<run_dt>.json`、`model_tag_feishu_summary_<run_dt>.md`、`model_tag_sync_manifest_<run_dt>.json`。
- 本地复核通过：`node --test model-tag-monitor/test/model-tag-snapshot.test.js`，5/5 pass。
- 本地 file-source smoke 通过：`tagged_model_count=1007`、`category_count=1`、`category=内存条`、status=warn；warn 原因是本地 `rules.json` 缺失使用 DEFAULT_RULES，且 `FEISHU_KNOWLEDGE_DOC` 未配置。
- 本地全量 `cd model-tag-monitor && npm test` 通过，177/177 pass。

待集成处理：

- 配置 Process Loop 环境变量 `MODEL_TAG_API_BASE` / `MODEL_TAG_ACCESS_CODE` / `FEISHU_KNOWLEDGE_DOC`。
- 确保真实 Process runner 将 `model_tag_sync_manifest` 的 source/stats/sha256/feishu_sync/known_gaps 合并进 `active_process_manifest`。
- Analyze 只能读 `model_tag_knowledge`，缺失标签按 `treat_as_未打标_and_do_not_infer_core/lifecycle/price` 处理。


## 8. D handoff 接收记录（2026-07-15 17:18）

### D 服务器接入 + 飞书 AI 摘要卡

已接收 handoff 并复核：

- 服务器旁路入口：`model-tag-monitor/scripts/render-ai-business-summary-dry-run.sh --source-dir <zloop_artifacts>/<run_dt> --run-dt <run_dt> --report-url <url> --dashboard-url <url> --outbox-dir tools/feishu_push/outbox`。
- 支持 `--source-dir` 目录模式与 `ZLOOP_ARTIFACT_PULL_CMD` hook 模式。
- 标准输入文件名：`insights.json` 必填；`summary.md`、`final_status.json`、`validation_report.json` 可选。
- Payload builder：`model-tag-monitor/scripts/build-ai-business-card-payload.js`。
- Payload checker：`model-tag-monitor/scripts/check-ai-business-card-payload.js`。
- 卡片模板：`tools/feishu_push/card_templates/ai_business_summary*.json`。

本地复核通过：

- `cd model-tag-monitor && node --test test/ai-business-card-payload.test.js`，4/4 pass。
- `cd model-tag-monitor && npm test`，177/177 pass。

硬约束保持：

- 旧 `monitor_weekly` 正式推送链路未改动。
- 新 `ai_business_summary` v1.5.5 只 dry-run/outbox，不正式推送。
- Checker 阻止 `dry_run_only=false`、缺四层摘要、`publish_allowed=true`、`push_allowed=true` 和技术字段泄漏（如 `orderRate`、`dealCnt`、`gmv`、`evidence_id`、`model_trace`、`board_metrics_feishu.csv`、`SQL`、`LLM`）。

待真实环境验证：

- 服务器确定 zloop 产物稳定目录或 hook 输出标准文件名。
- 人工 review 第一批 outbox 卡片内容。
- 如后续要正式推送，必须另加显式 feature flag，不在 v1.5.5 自动打开。


## 9. C handoff 接收记录（2026-07-15）

### C Analyze + Validate

已接收 handoff 并复核：

- Analyze 输入：`active_process_manifest.json`、`analysis_history_<run_dt>.json`、`model_tag_knowledge_<run_dt>.json`。
- Analyze 输出：`evidence_pack_<run_dt>.json`、`insights_<run_dt>.json`、`summary_<run_dt>.md`、`review_notes_<run_dt>.md`、`analysis_trace_<run_dt>.json`、`active_analysis_manifest.json`。
- Analyze 模式：daily = GLM-5.2 主生成 + DeepSeek V4 Pro 复核；deep_dive = DeepSeek V4 Pro 深挖 + GLM-5.2 结构化；`fallback_to_other_llm=false`。
- Validate 输入：`active_process_manifest.json`、`active_analysis_manifest.json`、`data_quality_report_<run_dt>.json`、`model_tag_knowledge_<run_dt>.json`、`evidence_pack_<run_dt>.json`、`insights_<run_dt>.json`、`summary_<run_dt>.md`、`review_notes_<run_dt>.md`、`analysis_trace_<run_dt>.json`。
- Validate 必检：evidence_id、schema、known_gap、LLM 白名单、history_weeks、过度归因、核心机型遗漏、高严重度异常遗漏。
- Validate 输出：`validation_report_<run_dt>.json`、`final_status_<run_dt>.json`、`active_validation_manifest.json`。

本地复核通过：

- `zloop skill-forge package-check zloop-skills/ai-wan-business-analyze`，0 warning。
- `zloop skill-forge package-check zloop-skills/ai-wan-business-validate`，0 warning。
- JSON parse check：Analyze/Validate manifest 与 insights schema 均 OK。

总控补齐：

- 将 C handoff 中 Validate 的完整输入补入 `ai-wan-business-validate/skill.manifest.json` 和四阶段产物契约。
- 将 `core_model_omission`、`high_severity_anomaly_omission` 补入 Validate manifest checks。

待真实链路验证：

- Process 必须真实输出 `analysis_history`、`model_tag_knowledge`、`model_tag_sync_manifest`、sha256、`history_weeks_available`/`analysis_scope_hint`。
- `effective_history_weeks < 8` 时 Analyze/Validate 只能允许 `wow_only`，禁止 8-10 周趋势结论。
- v1.5.5 即便 `final_status=pass`，仍保持 `publish_allowed=false`、`push_allowed=false`。


## 10. 真实场景一键测试脚本

总控已新增本地真实场景回放脚本：

```bash
scripts/run-ai-wan-v155-real-test.sh \
  --run-dt YYYY-MM-DD \
  --raw-export-dir /path/to/xinghe_exports \
  --out-dir /tmp/ai-wan-v155-real-test-YYYY-MM-DD \
  --server-snapshot-dir model-tag-monitor/data
```

脚本自动执行：

1. 检查 6 份 xinghe raw CSV 是否齐全；
2. 跑 Fetch `package-raw-cache.js` 生成 `raw_cache` 与 `active_fetch_manifest`；
3. 跑标签快照导出器生成 `model_tag_snapshot`、`model_tag_knowledge`、`model_tag_sync_manifest`；
4. 跑 Process `process-raw-cache.js` 生成 `server_cache_bundle`、`analysis_history`、`data_quality_report`、`active_process_manifest`；
5. 校验 zip、manifest、history_weeks、known_gaps；
6. 复跑四个 Skill 的 `zloop skill-forge package-check`；
7. 如传入 `--analysis-artifact-dir`，继续跑服务器 AI 摘要卡 dry-run/outbox；
8. 写出 `99_validation_summary.json`，其中包含下一步 zloop Analyze 的三个输入路径。

标准 raw CSV prefix：

```text
category_daily_avg*.csv
category_summary*.csv
category_fulfill_daily_avg*.csv
category_fulfill_summary*.csv
model_daily_avg*.csv
model_summary*.csv
```

如果已有 zloop Analyze/Validate 远端产物，可继续：

```bash
scripts/run-ai-wan-v155-real-test.sh \
  --run-dt YYYY-MM-DD \
  --raw-export-dir /path/to/xinghe_exports \
  --analysis-artifact-dir /path/to/downloaded_analyze_validate_artifacts \
  --report-url <zloop报告或产物链接> \
  --dashboard-url <经营看板链接>
```

v1.5.5 仍保持 dry-run：脚本不会正式发布 dashboard，也不会正式推送飞书。
