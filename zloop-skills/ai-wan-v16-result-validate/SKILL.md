---
name: AI小万结果校验 v1.6
description: AI 小万 v1.6/v1.7 validate 阶段 Skill：按旧服务器/v1.5.5 深度校验逻辑裁决 processed_data、analysis_result 和 display_insights，再通过 APIHub 最终写服务器并复读确认。
version: 1.6.5
---

# AI小万结果校验 v1.6

## 职责边界

本 Skill 只负责 `validate` 阶段：**旧逻辑深度校验 + v1.6 最终写服务器**。

必须做：

```text
接收 processed_data + analysis_result
→ 执行旧服务器/v1.5.5 校验逻辑
→ 生成 validation_report/final_status/validation_result
→ 通过 APIHub write 最终写服务器
→ reread 确认持久化
```

禁止做：

- 禁止重新跑 SQL。
- 禁止重做 process 数据处理。
- 禁止重写 analyze 结论；只能标记问题、降级、阻断或建议重跑。
- 禁止调用非白名单模型；如需语义复核，只允许 DeepSeek V4 Pro 给降级建议，不能直接改正文。
- 禁止在校验失败时仍设置 `publish_allowed=true`。
- 禁止把 `display_insights` 缺失或不合法的问题交给服务器 bridge 兜底；服务器只消费和发布，不生成业务文案。

## Runtime Client Gate

- runtime client：`hub`。
- 本阶段只允许通过 `zloop_runtime.hub` 相对路径调用：
  - read：`/v2/aiwan/api/aiwan/read`
  - write：`/v2/aiwan/api/aiwan/write`
- 禁止 `/gw/`、完整网关域名、Authorization、APIHub token、自定义上游凭证头。

## 执行前必读

任何 validate 运行必须读取：

```text
references/apihub-read-write-contract.md
references/api-playbook.md
references/display-insights-contract.md
references/insights-schema.json
references/model-tag-validation-contract.md
```

其中 `insights-schema.json` 和 `model-tag-validation-contract.md` 是从 v1.5.5/旧服务器校验链路迁入的核心规则；不得因为 v1.6 最终要写服务器而跳过。

## 输入

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "stage": "validate",
  "processed_data": {
    "stage": "process",
    "output_type": "processed_data",
    "metric_snapshot": {},
    "candidate_anomalies": [],
    "analysis_history": {},
    "model_tag_knowledge": {},
    "data_quality_report": {},
    "active_process_manifest": {}
  },
  "analysis_result": {
    "stage": "analyze",
    "output_type": "analysis_result",
    "analysis_scope": "trend_10w|wow_only",
    "history_weeks": 10,
    "evidence_pack": {},
    "insights": {},
    "summary": {},
    "findings": [],
    "display_contract": "dashboard-business-overview-insights-map/v1",
    "display_insights": {
      "board": "",
      "tiers": {"发展": "", "孵化": "", "种子": ""},
      "secondaryCategories": {},
      "categories": {},
      "category": "",
      "monitor": "",
      "warnings": []
    },
    "review_notes": [],
    "analysis_trace": {}
  },
  "scope": {"type": "weekly", "category": null}
}
```

## 旧服务器/v1.5.5 深度校验层

本阶段必须先完成以下 11 类校验，再决定是否允许写服务器。

### 1. lineage / run 一致性

检查：

- `processed_data.stage == process`
- `analysis_result.stage == analyze`
- `processed_data.run_id == analysis_result.run_id == 输入 run_id`
- `processed_data.week == analysis_result.week == 输入 week`
- `analysis_result.output_type == analysis_result`
- `processed_data.output_type == processed_data`
- 不得混入旧 `run_dt/week/run_id` 产物。

失败：critical failed。

### 2. 数据质量与旧服务器处理逻辑一致性

检查 process 结果是否体现旧服务器处理语义：

- `active_process_manifest` 或等价字段存在；
- `analysis_history` 存在；
- `data_quality_report` 存在；
- `server_cache_bundle` 或等价 `server_cache_bundle` 对象/摘要存在；
- `history_weeks_available`、`analysis_scope_hint`、`known_gaps` 被保留；
- `day_cnt/daysReceived`、rolling/final、`KEEP_WEEKS=10` 相关质量信息没有被丢弃。

若 process 明确标记 warn，可继续但必须进入 `warn_checks`；若关键加工产物缺失，failed。

### 3. history_weeks / 趋势范围

计算：

```text
effective_history_weeks =
  processed_data.active_process_manifest.history_weeks_available
  ?? processed_data.history_weeks_available
  ?? analysis_result.evidence_pack.history_weeks
  ?? analysis_result.history_weeks
```

规则：

- `effective_history_weeks < 8` 或 `analysis_scope=wow_only` 时，禁止“8周、10周、长期趋势、连续多周、趋势性改善/恶化”等确定性趋势结论。
- `analysis_scope=trend_10w` 时必须存在 `TREND_*` evidence。
- `analysis_result.history_weeks` 必须等于真实 `effective_history_weeks`，不能只写配置窗口 10。

### 4. evidence_id 完整性

构造 evidence universe：

```text
evidence_pack.evidence_index keys
+ category_top_changes[].evidence_id
+ cluster_top_changes[].evidence_id
+ model_contributors[].evidence_id
+ fulfillment_breakpoints[].evidence_id
+ trend_features[].evidence_id
+ data_quality_notes[].evidence_id
+ core_model_coverage[].evidence_id
```

检查：

- 每条 `findings/key_findings/risks/opportunities` 必须有非空 `evidence_ids`。
- 每个 `evidence_id` 必须存在于 evidence universe。
- `evidence_id` 不得重复。
- summary 中关键结论应带 evidence_id；无 ID 的强结论 warn 或 failed。

### 5. insights schema

使用 `references/insights-schema.json` 校验 `analysis_result.insights` 或其中等价的 insights 对象。

必须重点检查：

- `analysis_mode`、`analysis_scope`、`history_weeks`；
- insight 的 `evidence_ids/confidence/rule_status/model_trace`；
- `known_gaps` 与 process/evidence 对齐；
- `findings` 必须能从 insights 的 `key_findings/risks/opportunities` 回链。

schema 失败默认 failed，除非只是兼容字段缺失且 findings/evidence 完整，可 warn。

### 6. LLM 白名单

检查：

```text
analysis_result.analysis_trace.model_invocations[].model
analysis_result.analysis_trace.llm_policy
analysis_result.insights.*[].model_trace
analysis_result.review_notes
```

只允许：

```text
GLM-5.2
DeepSeek V4 Pro
```

`fallback_to_other_llm` 必须为 `false`。出现 `unknown/auto/default/fallback` 或第三模型：failed。

### 7. known_gap 使用

检查：

- `board_metrics_feishu.csv`、流量、入口、运营动作、库存、价格、竞品等缺口只能出现在 `known_gaps/data_quality_notes/pending_business_confirmation`。
- known_gap 不得被写为“导致/主因/确定原因”。
- `model_tag_knowledge` 缺失时，不得输出核心机型确定性结论。

### 8. 过度归因

强因果词包括：

```text
导致、主因、直接造成、确定因为、归因于、由…引起、根因是、唯一原因
```

规则：

- 强因果结论必须引用非 DQ/GAP 的业务 evidence，且最好有 category + model/fulfillment/trend 交叉证据。
- 单点环比或相关性证据只能 `pending_business_confirmation`。
- 涉及运营动作、库存、价格、竞品、流量入口等未在 evidence_pack 中出现的信息时，不得 confirmed。

严重过度归因 failed；轻微措辞 warn。

### 9. 核心机型遗漏与标签校验

必须按 `references/model-tag-validation-contract.md` 校验：

- `model_tag_knowledge` 与 snapshot/manifest 的 sha 或等价来源一致；
- insight 涉及“核心机型 / A层 / 高价段 / 生命周期”时，相关 evidence 必须有 tag enrichment 或等价标签证据；
- `core_model_coverage.high_delta_core_models` 不得遗漏；
- `core_models_missing_from_evidence` 必须有 DQ 解释；
- 标签缺失时所有标签/核心机型结论降级或阻断。

### 10. 高严重度异常遗漏与输出安全

检查：

- evidence_pack 中 `severity=high` 的 category/model/fulfillment/trend 证据，要么被 insight/finding 引用，要么在 review_notes 中解释为何降级。
- 输出不得包含“已正式发布、已推飞书、最终通过”等越权表述。
- 输出不得直接给调价、补贴、投放等强策略动作，只能给下钻方向和待确认事项。
- 最终 payload 必须可 JSON 序列化。

### 11. dashboard display_insights 展示契约

按 `references/display-insights-contract.md` 校验。服务器 bridge 已严格要求本结构；若不合法，服务器会保留 validate 写入和 run 状态修复，但不会生成 `business-overview-insights-<week>.json`。

检查：

- `analysis_result.display_contract === "dashboard-business-overview-insights-map/v1"`。
- `display_insights.board/category/monitor` 是非空 string。
- `display_insights.tiers` 必须包含非空 `发展`、`孵化`、`种子`。
- `display_insights.secondaryCategories` 与 `display_insights.categories` 必须是 object map。
- `secondaryCategories` key 必须能匹配 processed_data 或 server_context 中真实存在的二级类目/board。
- `categories` key 必须能匹配 processed_data、server_context 或品类映射表中的真实三级品类。
- 禁止 fuzzy match；无法匹配 key 是 critical failed。
- 三个分层文案不能只是空泛兜底，必须包含对应层指标证据，或明确数据风险/低基数/口径缺失。
- 展示文案禁止出现未证明业务口径词、技术字段、强策略动作或越权发布表述。
- `display_insights` 必须作为最终写服务器 payload 的一部分保留在 `analysis_result` 内，不能只写入 validate 摘要。

## validation_report / final_status

必须生成内嵌在 `validation_result` 中的 `validation_report`：

```json
{
  "schema_version": "ai_wan_validation_report/v1.6.5",
  "run_id": "",
  "week": "YYYY-Www",
  "checked_at": "",
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
  "summary": {"failed": 0, "warn": 0, "pass": 0}
}
```

必含 `check_id`：

```text
lineage_run_id
data_quality
history_weeks_scope
evidence_id_exists
insights_schema
known_gap_usage
llm_whitelist
over_attribution
core_model_omission
high_severity_omission
output_safety
display_insights_contract
server_payload_readiness
```

同时生成 `final_status`：

```json
{
  "overall_status": "success|warn|failed",
  "data_status": "success|warn|failed",
  "analysis_status": "success|warn|failed",
  "publish_allowed": true,
  "push_allowed": false,
  "reasons": [],
  "known_gaps": [],
  "blocking_checks": [],
  "warn_checks": []
}
```

裁决规则：

- 任一 critical check failed → `overall_status=failed`、`publish_allowed=false`。
- 无 failed 但存在 warn → `overall_status=warn`、`publish_allowed=true` 仅在服务器允许预览/带缺口展示时可为 true。
- 全部 pass → `overall_status=success`。
- `push_allowed` 默认 false，除非上游明确给出可推送策略；本 Skill 不主动推飞书。

## 执行步骤

1. 读取所有必读 reference。
2. 校验 `processed_data` 和 `analysis_result` 的 lineage、schema、evidence、history、known_gap、LLM、核心机型与输出安全。
3. 校验 `analysis_result.display_insights` 的 dashboard 展示结构、key 合法性、文案口径、三层完整性与服务器 bridge 发布就绪度。
4. 生成 `validation_result`，包含：
   - `validation_report`
   - `final_status`
   - `overall_status`
   - `publish_allowed`
   - `checks`
   - `warnings`
5. 如果 `overall_status=failed`，仍允许把失败校验结果写入服务器用于追踪，但 `publish_allowed=false`。
6. 通过 APIHub write 写入服务器，`stage=validate`，`output_type=validation_result`，payload 必须同时包含：
   - `processed_data`
   - `analysis_result`
   - `validation_result`
7. 写入后必须 reread `stage=validate`，确认 validate 结果已持久化，记录 `revision`。
8. 返回最终报告给主编排。

## 输出

```json
{
  "stage": "validate",
  "status": "success|warn|failed",
  "output_type": "validation_result",
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "overall_status": "success|warn|failed",
  "publish_allowed": true,
  "push_allowed": false,
  "checks": [],
  "warnings": [],
  "validation_report": {},
  "final_status": {},
  "server_write_confirmed": true,
  "revision": 1
}
```

## APIHub 契约

最终写入和复读确认时必须读取：

- `references/apihub-read-write-contract.md`
- `references/api-playbook.md`

只能使用包内 `scripts/aiwan_apihub.py` 或等价 `zloop_runtime.hub.post` 完成 read/write；禁止自建 HTTP 网关调用。
