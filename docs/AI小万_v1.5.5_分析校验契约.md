# AI 小万 v1.5.5 分析校验契约

## Analyze

- 输入：`active_process_manifest.json`、`analysis_history_<run_dt>.json`、`model_tag_knowledge_<run_dt>.json`。
- 前置：`stage=process`、`status in [success,warn]`、`run_dt` 一致、sha256 通过。
- 证据：必须先生成 `evidence_pack_<run_dt>.json`，不得把全量 Excel/raw CSV/model 明细直接交给 LLM。
- 证据域：`category_top_changes`、`model_contributors`、`fulfillment_breakpoints`、`trend_features`、`data_quality_notes`、`known_gaps`、`core_model_coverage`。
- 模式：daily = GLM-5.2 主生成 + DeepSeek V4 Pro 复核；deep_dive = DeepSeek V4 Pro 深挖 + GLM-5.2 结构化。
- 降级：先计算 `effective_history_weeks = history_weeks_available ?? history_weeks`；`effective_history_weeks < 8` 时 `analysis_scope=wow_only`，禁止 8-10 周趋势结论。

## Validate

- 输入：Process manifest、Analysis manifest、`data_quality_report`、`model_tag_knowledge`、`evidence_pack`、`insights`、`summary`、`review_notes`、`analysis_trace`。
- 必检：lineage/run_id、sha256、evidence_id 存在性、insights schema、known_gap 使用、LLM 白名单、effective_history_weeks 范围、过度归因、核心机型遗漏、高严重度异常遗漏。
- LLM：规则为主；语义复核只允许 DeepSeek V4 Pro，GLM-5.2 只做格式修复且不得改事实。
- 输出：`validation_report_<run_dt>.json`、`final_status_<run_dt>.json`、`active_validation_manifest.json`。
- 裁决：critical failed → failed；无 failed 有 warn → warn；全部通过 → pass。v1.5.5 dry-run 阶段 `publish_allowed=false`、`push_allowed=false`。
