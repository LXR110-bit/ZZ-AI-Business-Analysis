# AI 小万 v1.6 analyze evidence_pack 契约

## 目的

Analyze 阶段不直接让 LLM 消费全量 raw 数据、Excel、CSV 或服务器缓存。必须先从 `processed_data` 与 APIHub read 返回的 `server_context` 生成确定性 `evidence_pack`，再把压缩证据交给 GLM-5.2 和 DeepSeek V4 Pro。

本契约适配 v1.6 阶段边界：本阶段只读服务器、不跑 SQL、不写服务器，输出为 `analysis_result.evidence_pack`。

## 输入

必需：

- `processed_data`：来自 process 阶段，包含 `metric_snapshot`、`candidate_anomalies`、`process_summary`、`warnings`。

推荐通过 APIHub read 获取：

- `server_context.run_meta`
- `server_context.history_10w`
- `server_context.rules`
- `server_context.previous_stage_outputs`
- `server_context.model_tag_knowledge` 或等价标签/核心机型知识

APIHub read 失败时可以降级继续，但必须登记 `known_gaps` 与 `data_quality_notes`，不得伪造服务器数据。

## 顶层结构

```json
{
  "schema_version": "ai_wan_evidence_pack/v1.6.5",
  "run_id": "",
  "week": "YYYY-Www",
  "target_week": "YYYY-MM-DD",
  "previous_week": "YYYY-MM-DD",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "history_weeks_configured": 10,
  "effective_history_weeks_source": "processed_data.history_weeks_available",
  "server_context_used": true,
  "source_digests": {
    "processed_data": {"sha256": ""},
    "server_context": {"sha256": "", "read_status": "success|warn|failed"}
  },
  "quality_gates": {},
  "known_gaps": [],
  "evidence_index": {},
  "category_top_changes": [],
  "cluster_top_changes": [],
  "model_contributors": [],
  "fulfillment_breakpoints": [],
  "trend_features": [],
  "data_quality_notes": [],
  "core_model_coverage": []
}
```

`evidence_index` 必须把每个 `evidence_id` 映射到 `{ "section": "...", "offset": 0, "source": "..." }`，Validate 阶段据此判断引用是否存在。

## evidence_id 规则

每条证据必须有稳定且唯一的 ID：

| 类型 | 前缀 | 示例 |
| --- | --- | --- |
| 品类变化 | `CAT` | `CAT_GMV_UP_001` |
| 品类簇变化 | `CLUSTER` | `CLUSTER_GMV_DOWN_001` |
| 机型贡献 | `MODEL` | `MODEL_CONTRIB_001` |
| 履约断点 | `FULFILL` | `FULFILL_BREAK_001` |
| 趋势特征 | `TREND` | `TREND_10W_GMV_001` |
| 数据质量 | `DQ` | `DQ_SERVER_CONTEXT_UNAVAILABLE_001` |
| 已知缺口 | `GAP` | `GAP_MODEL_TAG_KNOWLEDGE_001` |
| 核心机型覆盖 | `CORE` | `CORE_MODEL_COVERAGE_001` |

生成规则建议：`<PREFIX>_<METRIC_OR_TOPIC>_<DIRECTION_OR_TYPE>_<3位序号>`。同一 run 内不得重复；跨 run 同一排序规则应稳定复现。

## 指标字段口径

从 `processed_data.metric_snapshot` 和 `candidate_anomalies` 读取时，优先识别规范化字段；不得因为中文字段缺失判定全零。

| 业务指标 | 首选字段 | 兼容字段 |
|---|---|---|
| 机况 UV | `jkuv` | `machineUv`, `机况UV` |
| 估价 UV | `evaUv` | `evalUv`, `估价UV` |
| 下单 UV | `orderUv` | `下单UV` |
| 下单量 | `orderCnt` | `order_count`, `下单量` |
| 发货量 | `shipCnt` | `deliverCnt`, `发货量` |
| 签收量 | `signCnt` | `receiveCnt`, `签收量` |
| 质检量 | `qcCnt` | `qualityCnt`, `质检量` |
| 成交量 | `dealCnt` | `成交量` |
| 退回量 | `returnCnt` | `退回量` |
| 成交 GMV | `gmv` | `dealGmv`, `成交GMV` |

判定 `all_data_zero_in_processed_data` 前，必须至少汇总 `metric_snapshot` 与 `candidate_anomalies` 中的 `gmv/dealCnt/orderCnt/evaUv/jkuv/orderUv`。只要任一核心指标非零，禁止写 all-zero gap。

## category_top_changes

字段：

```json
{
  "evidence_id": "CAT_GMV_DOWN_001",
  "level": "category",
  "category": "品类名称",
  "metric": "gmv",
  "current_value": 0,
  "previous_value": 0,
  "delta": 0,
  "wow_pct": 0,
  "rank_by_abs_delta": 1,
  "severity": "high|medium|low|watch",
  "source": "processed_data.metric_snapshot.category|candidate_anomalies",
  "week": "YYYY-Www",
  "target_week": "YYYY-MM-DD",
  "previous_week": "YYYY-MM-DD"
}
```

推荐至少抽取：GMV 涨跌 Top、成交量涨跌 Top、下单量涨跌 Top、估价 UV / 机况 UV 异动 Top、大品类绝对变化较大的观察项。

`previous_value` 为 0 或缺失时，`wow_pct=null`，并新增 DQ 证据，不得输出普通百分比。

## cluster_top_changes

当 `metric_snapshot` 存在品类簇/业务簇结构时生成：

```json
{
  "evidence_id": "CLUSTER_GMV_UP_001",
  "level": "cluster",
  "cluster": "电脑办公",
  "metric": "gmv",
  "current_value": 0,
  "previous_value": 0,
  "delta": 0,
  "wow_pct": 0,
  "top_categories": [],
  "severity": "high|medium|low|watch",
  "source": "processed_data.metric_snapshot.cluster"
}
```

没有品类簇数据时不虚构，只写 `GAP_CLUSTER_DATA_UNAVAILABLE_*`（如果用户/规则要求看簇）。

## model_contributors

字段：

```json
{
  "evidence_id": "MODEL_CONTRIB_001",
  "level": "model",
  "category": "品类名称",
  "model_id": "",
  "model_name": "",
  "metric": "gmv",
  "current_value": 0,
  "previous_value": 0,
  "delta": 0,
  "wow_pct": 0,
  "contribution_pct": 0,
  "core_attr_eval": "",
  "grade_eval": "",
  "core_attr_qc": "",
  "grade_qc": "",
  "fulfillment": "",
  "tag_enrichment": {},
  "is_core_model": false,
  "core_rank": null,
  "tag_ids": [],
  "tag_names": [],
  "knowledge_version": "",
  "severity": "high|medium|low|watch",
  "source": "processed_data + server_context.model_tag_knowledge"
}
```

推荐抽取：对品类 GMV delta 贡献最大的机型组合、对品类成交量 delta 贡献最大的机型组合、核心机型明显上涨/下滑、高客单价机型异常、同一机型不同履约方式表现分化。

`contribution_pct = model_delta / category_delta`；当分母为 0 或缺失时为 `null` 并生成 DQ 证据。

## fulfillment_breakpoints

字段：

```json
{
  "evidence_id": "FULFILL_BREAK_001",
  "level": "fulfillment",
  "category": "品类名称",
  "fulfillment": "履约方式",
  "breakpoint": "下单量上涨但成交量未上涨",
  "metrics": {
    "order_cnt_delta": 0,
    "ship_cnt_delta": 0,
    "sign_cnt_delta": 0,
    "qc_cnt_delta": 0,
    "deal_cnt_delta": 0,
    "return_cnt_delta": 0
  },
  "severity": "high|medium|low|watch",
  "source": "processed_data.metric_snapshot.fulfillment|candidate_anomalies"
}
```

推荐断点链路：

```text
下单量 → 发货量 → 签收量 → 质检量 → 成交量 → 退回量
```

## trend_features

仅当 `effective_history_weeks >= 8` 时生成；其中 `effective_history_weeks` 优先取真实可用历史，而不是配置窗口。字段：

```json
{
  "evidence_id": "TREND_10W_GMV_001",
  "level": "category|cluster|model|fulfillment|overall",
  "entity": "",
  "metric": "gmv",
  "history_weeks": 10,
  "current_value": 0,
  "median_8w": 0,
  "avg_8w": 0,
  "z_score": 0,
  "streak": "up_3w|down_3w|none",
  "trend_direction": "up|down|flat|volatile",
  "severity": "high|medium|low|watch",
  "source": "server_context.history_10w|processed_data.metric_snapshot.history"
}
```

如果 `effective_history_weeks < 8`：

- `analysis_scope=wow_only`；
- 不生成确定性 `TREND_*` 证据；
- 生成 `DQ_HISTORY_INSUFFICIENT_001`，说明趋势分析禁用。

## data_quality_notes / known_gaps

必须显式记录：

- APIHub read 失败或部分字段缺失；
- process 阶段 warning；
- previous_value 为 0 导致环比不可计算；
- 某层级、某历史窗口、某字段缺失；
- `metric_snapshot` 与 `candidate_anomalies` 不一致；
- 上游质量门禁 warning / failed；
- `model_tag_knowledge` 缺失、过期或无法覆盖核心品类；
- history 不足导致 `wow_only` 降级。

## core_model_coverage

字段：

```json
{
  "evidence_id": "CORE_MODEL_COVERAGE_001",
  "category": "品类名称",
  "knowledge_version": "",
  "core_models_expected": [
    {"model_id": "", "model_name": "", "core_rank": 1}
  ],
  "core_models_observed": ["model_id_or_name"],
  "core_models_missing_from_evidence": ["model_id_or_name"],
  "high_delta_core_models": ["model_id_or_name"],
  "source": "server_context.model_tag_knowledge + model_contributors"
}
```

如果核心机型在标签知识中存在且在 `processed_data` 中出现高波动，但没有进入 `model_contributors` 或 insights 引用，Validate 阶段必须报核心机型遗漏。

## 交给 LLM 前的压缩原则

- 不传全量明细；
- 只传 Top 证据、贡献度证据、断点证据、趋势特征、核心机型覆盖和质量说明；
- 所有证据保留 `source` 和 `evidence_id`；
- 所有结论必须能回链到 evidence_id；
- known_gap 只能作为缺口或待确认事项，不能作为确定性归因。
