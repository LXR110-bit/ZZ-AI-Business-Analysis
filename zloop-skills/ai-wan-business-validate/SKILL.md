---
name: 小万经营校验
description: AI 小万 v1.5.5 四阶段流水线第 4 阶段：消费 Process 与 Analyze 产物，执行 evidence_id、schema、known_gap、LLM 白名单、history_weeks、过度归因和核心机型遗漏校验，输出 validation_report 与 final_status。
version: 1.5.5
---

# 小万经营校验

## 所属流程与边界

本 Skill 是 AI 小万 v1.5.5 四阶段流水线第 4 阶段：

```text
Fetch 取数 → Process 数据处理/缓存 → Analyze 经营分析 → Validate 数据校验
```

本阶段负责最终质量裁决。它不跑 SQL、不重新做数据处理、不重新生成洞察正文、不发布 dashboard、不推飞书。默认 `publish_allowed=false`、`push_allowed=false`，即使校验通过也只代表产物可信，可供后续服务器 dry-run 拉取。

## 必读参考

执行前必须读取：

```text
references/insights-schema.json
```

如果需要语义复核，只允许 DeepSeek V4 Pro 做 reviewer；GLM-5.2 只允许做 JSON 格式修复，不允许改事实。

## 输入要求

必须读取并校验：

```text
active_process_manifest.json
active_analysis_manifest.json
data_quality_report_<run_dt>.json
evidence_pack_<run_dt>.json
insights_<run_dt>.json
summary_<run_dt>.md
review_notes_<run_dt>.md
analysis_trace_<run_dt>.json
```

如 Process 阶段提供，也必须读取：

```text
model_tag_knowledge_<run_dt>.json
```

## 前置检查

必须满足：

```text
process.run_dt == analysis.run_dt == 当前 run_dt
process.status in [success, warn]
analysis.status in [success, warn]
analysis.upstream_run_id == process.run_id
所有 active manifest 指向的产物 sha256 校验通过
不得混入旧 run_dt 产物
```

任何前置检查失败：

```text
overall_status=failed
publish_allowed=false
push_allowed=false
```

## 校验分层

### 1. lineage 与数据质量校验（规则为主）

检查：

- fetch / process / analysis `run_id` 是否串联；
- `run_dt` 是否一致；
- `effective_history_weeks >= 8` 才允许 `analysis_scope=trend_10w`；`effective_history_weeks` 优先取 `active_process_manifest.history_weeks_available`，再取 `analysis_history.history_weeks_available`，最后才取 `history_weeks`；
- `day_cnt` / `rolling_status` 是否合理；
- `data_quality_report` 是否 pass 或可接受 warn；
- `server_cache_bundle` 是否存在；
- `board_metrics_feishu.csv` 缺口是否写入 process / evidence / insights 的 `known_gaps`；
- `model_tag_knowledge` 是否存在，若缺失必须降级并阻止核心机型确定性结论。

### 2. evidence_id 校验（规则为主）

构造 evidence universe：

```text
evidence_pack.evidence_index keys
+ category_top_changes[].evidence_id
+ model_contributors[].evidence_id
+ fulfillment_breakpoints[].evidence_id
+ trend_features[].evidence_id
+ data_quality_notes[].evidence_id
+ core_model_coverage[].evidence_id
```

检查：

- 每条 `key_findings` / `risks` / `opportunities` 必须有非空 `evidence_ids`；
- 每个 `evidence_id` 必须存在于 evidence universe；
- evidence_id 不得重复；
- 不允许引用 raw Excel / 全量 CSV / server cache 作为唯一证据；
- summary.md 中的关键结论应带 evidence_id；无 ID 的强结论记为 warn 或 failed。

### 3. schema 校验（规则为主）

使用 `references/insights-schema.json` 校验 `insights_<run_dt>.json`。必须重点校验：

- 顶层 `analysis_mode`、`analysis_scope`、`history_weeks`；其中 `history_weeks` 必须等于 effective_history_weeks，不能等于配置保留窗口；
- 每条 insight 的 `evidence_ids`、`confidence`、`rule_status`、`model_trace`；
- `model_trace` 中所有模型名只能是 GLM-5.2 / DeepSeek V4 Pro；
- `known_gaps` 必须存在且与 evidence_pack / process_manifest 对齐。

schema 失败默认 `analysis_status=failed`。

### 4. LLM 白名单校验（规则为主）

检查以下位置：

```text
active_analysis_manifest.llm_policy
analysis_trace.model_invocations[].model
insights.*[].model_trace.primary/reviewer/formatter
review_notes 标题或元信息中的 reviewer
```

只允许：

```text
GLM-5.2
DeepSeek V4 Pro
```

检查：

- `fallback_to_other_llm` 必须为 `false`；
- 不得出现其他模型名、unknown、auto、fallback、default；
- daily 模式应为 GLM-5.2 主生成 + DeepSeek V4 Pro 复核；
- deep_dive 模式应为 DeepSeek V4 Pro 深挖 + GLM-5.2 结构化。

违反白名单：`analysis_status=failed`。

### 5. history_weeks / 趋势结论校验（规则为主）

先计算：

```text
effective_history_weeks = active_process_manifest.history_weeks_available
  ?? analysis_history.history_weeks_available
  ?? insights.history_weeks
  ?? evidence_pack.history_weeks
```

当 `effective_history_weeks < 8` 或 `analysis_scope=wow_only`：

- 禁止 insights / summary / review_notes 出现“8周”“10周”“长期趋势”“连续多周”“趋势性改善/恶化”等确定性趋势结论；
- 禁止引用 `TREND_*` 作为 confirmed 结论；
- 若出现，`analysis_status=failed`。

当 `effective_history_weeks >= 8` 且 `analysis_scope=trend_10w`：

- 趋势结论必须引用 `TREND_*` evidence_id；
- 没有 `TREND_*` 证据却写趋势结论，记为 failed。

### 6. known_gap 校验（规则 + 可选语义复核）

检查：

- `board_metrics_feishu.csv` 缺口必须出现在 known_gaps；
- APP DAU、入口 UV、聚合回收渗透率、真实渗透率等大盘流量指标不得被写成确定性原因；
- 缺失的 `model_tag_knowledge` 不得被写成核心机型确定性判断；
- known_gap 只能出现在 `data_quality_notes`、`known_gaps` 或 `pending_business_confirmation` 中。

如 known_gap 被写为“导致/主因/确定原因”，`analysis_status=failed`。

### 7. 过度归因校验（规则 + DeepSeek 可选）

强因果词包括但不限于：

```text
导致、主因、直接造成、确定因为、归因于、由…引起、根因是、唯一原因
```

校验规则：

- 强因果结论必须至少引用一个非 DQ/GAP 的业务 evidence_id，且最好包含 category + model/fulfillment/trend 交叉证据；
- 仅有相关性或单点环比证据时，必须写“可能相关 / 待确认”，`rule_status=pending_business_confirmation`；
- 涉及运营动作、库存、价格、竞品、流量入口等未在 evidence_pack 中出现的信息时，不得 confirmed；
- DeepSeek V4 Pro 可对文本做语义复核，但只能输出降级建议，不直接改正文。

过度归因严重时 failed；轻微措辞问题 warn。

### 8. 核心机型遗漏校验（规则为主，必要时 DeepSeek 复核）

基于：

```text
evidence_pack.core_model_coverage
model_tag_knowledge_<run_dt>.json
evidence_pack.model_contributors
```

检查：

- `core_models_missing_from_evidence` 非空且无 DQ 解释：warn；
- `high_delta_core_models` 中的机型没有进入 `model_contributors` 或 insights 引用：failed 或 warn（按 severity）；
- insights 对品类大幅波动归因时，必须覆盖该品类 Top 核心机型；
- 如果 `model_tag_knowledge` 缺失，不能通过核心机型确定性结论，只能 warn 并要求补齐。

### 9. 高严重度异常遗漏校验

检查 evidence_pack 中 `severity=high` 的：

```text
category_top_changes
model_contributors
fulfillment_breakpoints
trend_features
```

若高严重度 evidence 没有被任何 insight 引用，也没有在 review_notes 中解释为降级/忽略，记为 warn；若同时影响核心品类或核心机型，记为 failed。

## validation_report 输出

必须输出：

```text
validation_report_<run_dt>.json
```

建议结构：

```json
{
  "schema_version": "ai_wan_validation_report/v1.5.5",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "checked_at": "",
  "input_manifests": {
    "process_run_id": "",
    "analysis_run_id": ""
  },
  "checks": [
    {
      "check_id": "evidence_id_exists",
      "status": "pass|warn|failed",
      "severity": "critical|major|minor",
      "message": "",
      "affected_items": [],
      "suggested_fix": ""
    }
  ],
  "semantic_review": {
    "used_llm": false,
    "model": "DeepSeek V4 Pro",
    "notes": []
  },
  "summary": {
    "failed": 0,
    "warn": 0,
    "pass": 0
  }
}
```

必含 `check_id`：

```text
lineage_run_id
sha256_integrity
history_weeks_scope
evidence_id_exists
insights_schema
known_gap_usage
llm_whitelist
over_attribution
core_model_omission
high_severity_omission
output_safety
```

## final_status 输出

必须输出：

```text
final_status_<run_dt>.json
```

结构：

```json
{
  "run_dt": "YYYY-MM-DD",
  "overall_status": "pass|warn|failed",
  "data_status": "pass|warn|failed",
  "analysis_status": "pass|warn|failed",
  "publish_allowed": false,
  "push_allowed": false,
  "reasons": [],
  "known_gaps": [],
  "blocking_checks": [],
  "warn_checks": []
}
```

裁决规则：

- 任一 critical check failed → `overall_status=failed`；
- 无 failed 但存在 warn → `overall_status=warn`；
- 全部 pass → `overall_status=pass`；
- v1.5.5 dry-run 阶段无论 pass/warn/failed，`publish_allowed=false`、`push_allowed=false`。

## active_validation_manifest 输出

必须输出：

```json
{
  "stage": "validation",
  "status": "success|warn|failed",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "upstream_stage": "analysis",
  "upstream_run_id": "",
  "validation_report": "validation_report_<run_dt>.json",
  "final_status": "final_status_<run_dt>.json",
  "sha256": {},
  "publish_allowed": false,
  "push_allowed": false
}
```

## 成功判定

- validation_report 生成；
- final_status 生成；
- active_validation_manifest 更新；
- 若有 warn/failed，必须列出原因、影响范围和建议修复；
- 不自动发布 dashboard、不自动推飞书。
