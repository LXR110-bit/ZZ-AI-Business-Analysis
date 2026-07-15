# AI 小万 v1.5.5 经营洞察 evidence_pack 契约

## 目的

LLM 不直接吃全量 Excel、raw CSV 或 server cache。Analyze 阶段必须先从 `analysis_history` 与 `model_tag_knowledge` 生成确定性 evidence_pack，再把压缩证据交给 GLM-5.2 和 DeepSeek V4 Pro。

## 输入

必需：

- `active_process_manifest.json`
- `analysis_history_<run_dt>.json`
- `model_tag_knowledge_<run_dt>.json`

可选，仅用于回链：

- `server_cache_bundle_<run_dt>.zip`

## 顶层结构

```json
{
  "schema_version": "ai_wan_evidence_pack/v1.5.5",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "target_week": "YYYY-MM-DD",
  "previous_week": "YYYY-MM-DD",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "history_weeks_configured": 10,
  "effective_history_weeks_source": "active_process_manifest.history_weeks_available",
  "source_digests": {
    "analysis_history": { "path": "", "sha256": "" },
    "model_tag_knowledge": { "path": "", "sha256": "" }
  },
  "quality_gates": {},
  "known_gaps": [],
  "evidence_index": {},
  "category_top_changes": [],
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
| 机型贡献 | `MODEL` | `MODEL_CONTRIB_001` |
| 履约断点 | `FULFILL` | `FULFILL_BREAK_001` |
| 趋势特征 | `TREND` | `TREND_10W_GMV_001` |
| 数据质量 | `DQ` | `DQ_MISSING_BOARD_001` |
| 已知缺口 | `GAP` | `GAP_BOARD_METRICS_001` |
| 核心机型覆盖 | `CORE` | `CORE_MODEL_COVERAGE_001` |

生成规则建议：`<PREFIX>_<METRIC_OR_TOPIC>_<DIRECTION_OR_TYPE>_<3位序号>`。同一 run 内不得重复；跨 run 同一排序规则可稳定复现。

## category_top_changes

字段：

```json
{
  "evidence_id": "CAT_GMV_DOWN_001",
  "level": "category",
  "category": "品类名称",
  "metric": "成交gmv",
  "current_value": 0,
  "previous_value": 0,
  "delta": 0,
  "wow_pct": 0,
  "rank_by_abs_delta": 1,
  "severity": "high|medium|low|watch",
  "source": "analysis_history.category_summary",
  "week_start_date": "YYYY-MM-DD",
  "previous_week_start_date": "YYYY-MM-DD"
}
```

推荐至少抽取：GMV 涨跌 Top 10、成交量涨跌 Top 10、下单量涨跌 Top 10、估价 UV / 机况 UV 异动 Top 10、大品类绝对变化较大的观察项。

`previous_value` 为 0 或缺失时，`wow_pct=null`，并新增 DQ 证据，不得输出普通百分比。

## model_contributors

字段：

```json
{
  "evidence_id": "MODEL_CONTRIB_001",
  "level": "model",
  "category": "品类名称",
  "model_id": "",
  "model_name": "",
  "metric": "成交gmv",
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
  "is_core_model": false,
  "core_rank": null,
  "tag_ids": [],
  "tag_names": [],
  "knowledge_version": "",
  "severity": "high|medium|low|watch",
  "source": "analysis_history.model_summary + model_tag_knowledge"
}
```

推荐抽取：对品类 GMV delta 贡献最大的机型组合、对品类成交量 delta 贡献最大的机型组合、核心机型（`is_core_model=true`）明显上涨/下滑、高客单价机型异常、同一机型不同履约方式表现分化。

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
    "deliver_cnt_delta": 0,
    "receive_cnt_delta": 0,
    "qc_cnt_delta": 0,
    "deal_cnt_delta": 0,
    "return_cnt_delta": 0
  },
  "severity": "high|medium|low|watch",
  "source": "analysis_history.category_fulfill_summary"
}
```

推荐断点链路：

```text
下单量 → 发货量 → 签收量 → 质检量 → 成交量 → 退回量
```

## trend_features

仅当 `effective_history_weeks >= 8` 时生成；其中 `effective_history_weeks` 优先取 `history_weeks_available`，避免把配置保留窗口误判成真实可用历史。字段：

```json
{
  "evidence_id": "TREND_10W_GMV_001",
  "level": "category|model|fulfillment|overall",
  "entity": "",
  "metric": "成交gmv",
  "history_weeks": 10,
  "current_value": 0,
  "median_8w": 0,
  "avg_8w": 0,
  "z_score": 0,
  "streak": "up_3w|down_3w|none",
  "trend_direction": "up|down|flat|volatile",
  "severity": "high|medium|low|watch",
  "source": "analysis_history"
}
```

如果 `effective_history_weeks < 8`：

- `analysis_scope=wow_only`；
- 不生成确定性 `TREND_*` 证据；
- 生成 `DQ_HISTORY_INSUFFICIENT_001`，说明趋势分析禁用。

## data_quality_notes / known_gaps

必须显式记录：

- `board_metrics_feishu.csv` 缺失；
- previous_value 为 0 导致环比不可计算；
- 某 Sheet / 某历史窗口缺失；
- manifest 与 history 行数不一致；
- `header_normalized != true`；
- 上游质量门禁 warning / failed；
- `model_tag_knowledge` 缺失、过期或无法覆盖核心品类。

## core_model_coverage

字段：

```json
{
  "evidence_id": "CORE_MODEL_COVERAGE_001",
  "category": "品类名称",
  "knowledge_version": "",
  "core_models_expected": [
    { "model_id": "", "model_name": "", "core_rank": 1 }
  ],
  "core_models_observed": ["model_id_or_name"],
  "core_models_missing_from_evidence": ["model_id_or_name"],
  "high_delta_core_models": ["model_id_or_name"],
  "source": "model_tag_knowledge + model_contributors"
}
```

如果核心机型在 `model_tag_knowledge` 中存在且在 `analysis_history` 中出现高波动，但没有进入 `model_contributors` 或 insights 引用，Validate 阶段必须报核心机型遗漏。

## 交给 LLM 前的压缩原则

- 不传全量明细；
- 只传 Top 证据、贡献度证据、断点证据、趋势特征、核心机型覆盖和质量说明；
- 所有证据保留 `source` 和 `evidence_id`；
- 所有结论必须能回链到 evidence_id。
