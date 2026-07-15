# AI 小万 v1.5.5 四阶段产物契约

## 0. 全局规则

- `run_dt`：默认按 T-1 业务日期，由 Loop 入参或调度上下文传入；下游不得用系统日期猜测上游日期。
- `run_id`：每阶段生成稳定唯一 ID；下游 manifest 必须记录 `upstream_run_id`。
- `contract_version`：所有 manifest 必须显式写版本，当前为 `ai-wan-v1.5.5-*`。
- `artifact_hashes`：所有核心产物必须记录 sha256；下游消费前必须校验。
- 下游阶段发现上游失败、缺失、日期不一致或 sha 不一致时，必须停止或输出 failed，不允许静默读取旧文件。
- Fetch / Process 不调用 LLM；Analyze / Validate 只允许 `GLM-5.2` 与 `DeepSeek V4 Pro`。
- v1.5.5 所有产物默认 dry-run；`publish_allowed=false`、`push_allowed=false` 是首版默认值。

## 1. Fetch 阶段契约

### 输入

```json
{
  "run_dt_policy": "T-1",
  "sql_scope": "all",
  "sql_scripts": [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
    "model_daily_avg",
    "model_summary"
  ]
}
```

### 输出

```text
raw_cache_<run_dt>.zip
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
active_fetch_manifest.json
```

`raw_cache` 解压后至少包含：

```text
raw/*.csv
sql/*.sql
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
```

### `active_fetch_manifest.json` 最小字段

```json
{
  "contract_version": "ai-wan-v1.5.5-fetch",
  "stage": "fetch",
  "status": "success|failed",
  "run_id": "fetch-YYYYMMDD-...",
  "run_dt": "YYYY-MM-DD",
  "generated_at": "ISO-8601",
  "raw_cache": "raw_cache_<run_dt>.zip",
  "sql_status": "sql_status_<run_dt>.json",
  "raw_manifest": "raw_manifest_<run_dt>.json",
  "artifact_hashes": {
    "raw_cache": "sha256",
    "sql_status": "sha256",
    "raw_manifest": "sha256"
  },
  "row_counts": {
    "category_daily_avg": 0,
    "category_summary": 0,
    "category_fulfill_daily_avg": 0,
    "category_fulfill_summary": 0,
    "model_daily_avg": 0,
    "model_summary": 0
  }
}
```

## 2. Process 阶段契约

### 前置检查

必须读取并校验 `active_fetch_manifest.json`：

```text
stage=fetch
status=success
run_dt=当前 run_dt
raw_cache sha256 校验通过
raw_manifest.run_id == active_fetch_manifest.run_id
```

### 必做处理逻辑

- 表头规范化；
- Sheet5 model 粒度与旧 Excel 口径保持一致；
- 逗号机型名修复；
- `day_cnt` / `已收到天数` / `daysReceived` 周日均归一化；
- rolling 当前周覆盖；
- final 周冻结；
- 最近 10 周 history cache；
- 生成 `server_cache_bundle`；
- 生成面向 Analyze 的轻量 `analysis_history`；
- 生成 `data_quality_report`；
- 从服务器同步 `tags.json` / `tag-vocab.json` / `rules.json`，生成 `model_tag_snapshot` 和 `model_tag_knowledge`。

### 输出

```text
imports_<run_dt>.zip
AI小万_聚合回收经营分析_<run_dt>.xlsx
manifest_<run_dt>.json
processed_cache_<run_dt>.zip
server_cache_bundle_<run_dt>.zip
analysis_history_<run_dt>.json
data_quality_report_<run_dt>.json
model_tag_snapshot_<run_dt>.json
model_tag_knowledge_<run_dt>.json
model_tag_feishu_summary_<run_dt>.md
model_tag_sync_manifest_<run_dt>.json
active_process_manifest.json
```

### `active_process_manifest.json` 最小字段

```json
{
  "contract_version": "ai-wan-v1.5.5-process",
  "stage": "process",
  "status": "success|warn|failed",
  "run_id": "process-YYYYMMDD-...",
  "run_dt": "YYYY-MM-DD",
  "generated_at": "ISO-8601",
  "upstream_stage": "fetch",
  "upstream_run_id": "fetch-YYYYMMDD-...",
  "history_weeks": 10,
  "history_weeks_available": 0,
  "min_history_weeks_for_trend": 8,
  "analysis_scope_hint": "trend_10w|wow_only",
  "dashboard_window_weeks": 2,
  "imports_zip": "imports_<run_dt>.zip",
  "excel": "AI小万_聚合回收经营分析_<run_dt>.xlsx",
  "processed_cache": "processed_cache_<run_dt>.zip",
  "server_cache_bundle": "server_cache_bundle_<run_dt>.zip",
  "analysis_history": "analysis_history_<run_dt>.json",
  "data_quality_report": "data_quality_report_<run_dt>.json",
  "model_tag_snapshot": "model_tag_snapshot_<run_dt>.json",
  "model_tag_knowledge": "model_tag_knowledge_<run_dt>.json",
  "model_tag_feishu_summary": "model_tag_feishu_summary_<run_dt>.md",
  "model_tag_sync_manifest": "model_tag_sync_manifest_<run_dt>.json",
  "quality_gates": "pass|warn|failed",
  "known_gaps": [],
  "artifact_hashes": {
    "server_cache_bundle": "sha256",
    "analysis_history": "sha256",
    "data_quality_report": "sha256",
    "model_tag_snapshot": "sha256",
    "model_tag_knowledge": "sha256",
    "model_tag_sync_manifest": "sha256"
  }
}
```

### 降级规则

- `effective_history_weeks = history_weeks_available ?? history_weeks`。
- `effective_history_weeks >= 8`：Analyze 可输出 8-10 周趋势。
- `effective_history_weeks < 8`：Analyze 必须降级为 `wow_only`。
- `board_metrics_feishu.csv` 缺失：写入 `known_gaps`，不得转成确定性经营结论。
- 标签快照失败：输出 warn，并允许数据链路继续；Analyze 必须降低标签相关结论置信度。
- `model_tag_sync_manifest` 必须合并进 `active_process_manifest`，至少包含 snapshot/knowledge 文件名、sha256、source、stats、feishu_sync、known_gaps。

## 3. Analyze 阶段契约

### 前置检查

必须读取并校验：

```text
active_process_manifest.json
analysis_history_<run_dt>.json
model_tag_knowledge_<run_dt>.json
```

要求：

```text
active_process_manifest.stage == process
active_process_manifest.status in [success, warn]
active_process_manifest.run_dt == 当前 run_dt
analysis_history sha256 校验通过
model_tag_knowledge sha256 校验通过；缺失时只能 warn，不得编造标签知识
```

### 输出

```text
evidence_pack_<run_dt>.json
insights_<run_dt>.json
summary_<run_dt>.md
review_notes_<run_dt>.md
analysis_trace_<run_dt>.json
active_analysis_manifest.json
```

### `active_analysis_manifest.json` 最小字段

```json
{
  "contract_version": "ai-wan-v1.5.5-analysis",
  "stage": "analysis",
  "status": "success|warn|failed",
  "run_id": "analysis-YYYYMMDD-...",
  "run_dt": "YYYY-MM-DD",
  "generated_at": "ISO-8601",
  "upstream_stage": "process",
  "upstream_run_id": "process-YYYYMMDD-...",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "evidence_pack": "evidence_pack_<run_dt>.json",
  "insights": "insights_<run_dt>.json",
  "summary": "summary_<run_dt>.md",
  "review_notes": "review_notes_<run_dt>.md",
  "analysis_trace": "analysis_trace_<run_dt>.json",
  "llm_policy": {
    "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"],
    "fallback_to_other_llm": false
  },
  "artifact_hashes": {
    "evidence_pack": "sha256",
    "insights": "sha256",
    "summary": "sha256",
    "review_notes": "sha256",
    "analysis_trace": "sha256"
  },
  "known_gaps": []
}
```

### 硬性要求

- 必须先生成 `evidence_pack`，再调用 LLM。
- 不允许把全量 Excel 或全量明细直接喂给 LLM。
- 每条 insight 必须引用至少一个 `evidence_id`。
- `effective_history_weeks < 8` 时禁止输出长期趋势和连续多周定性；`history_weeks_available` 优先于配置保留窗口 `history_weeks`。
- 模型不可用时不得换第三模型，只能 warn/failed。

## 4. Validate 阶段契约

### 前置检查

必须读取并校验：

```text
active_process_manifest.json
active_analysis_manifest.json
data_quality_report_<run_dt>.json
model_tag_knowledge_<run_dt>.json
evidence_pack_<run_dt>.json
insights_<run_dt>.json
summary_<run_dt>.md
review_notes_<run_dt>.md
analysis_trace_<run_dt>.json
```

要求：

```text
run_dt 一致
run_id 串联
artifact_hashes 校验通过
analysis_trace 中无非白名单模型
```

### 输出

```text
validation_report_<run_dt>.json
final_status_<run_dt>.json
active_validation_manifest.json
```

### `validation_report_<run_dt>.json` 必查项

```json
{
  "checks": [
    "data_quality",
    "history_window",
    "evidence_id",
    "insights_schema",
    "model_tag_knowledge",
    "known_gap",
    "llm_policy",
    "over_attribution",
    "output_safety",
    "core_model_omission",
    "high_severity_anomaly_omission",
    "card_payload_readiness"
  ]
}
```

### `final_status_<run_dt>.json` 最小字段

```json
{
  "contract_version": "ai-wan-v1.5.5-final-status",
  "run_dt": "YYYY-MM-DD",
  "overall_status": "pass|warn|failed",
  "data_status": "pass|warn|failed",
  "analysis_status": "pass|warn|failed",
  "publish_allowed": false,
  "push_allowed": false,
  "reasons": [],
  "known_gaps": []
}
```

### `active_validation_manifest.json` 最小字段

```json
{
  "contract_version": "ai-wan-v1.5.5-validation",
  "stage": "validation",
  "status": "success|warn|failed",
  "run_id": "validation-YYYYMMDD-...",
  "run_dt": "YYYY-MM-DD",
  "generated_at": "ISO-8601",
  "upstream_process_run_id": "process-YYYYMMDD-...",
  "upstream_analysis_run_id": "analysis-YYYYMMDD-...",
  "validation_report": "validation_report_<run_dt>.json",
  "final_status": "final_status_<run_dt>.json",
  "publish_allowed": false,
  "push_allowed": false,
  "artifact_hashes": {
    "validation_report": "sha256",
    "final_status": "sha256"
  }
}
```

## 5. 服务器消费契约

服务器只消费 Validate 后可审计产物：

```text
active_validation_manifest.json
final_status_<run_dt>.json
validation_report_<run_dt>.json
server_cache_bundle_<run_dt>.zip
insights_<run_dt>.json
summary_<run_dt>.md
```

消费规则：

- `final_status.overall_status=failed`：不得更新展示缓存，不生成 AI 摘要卡正式 payload。
- `final_status.overall_status=warn`：可生成预览和 outbox，但卡片必须展示 known_gap/谨慎标识。
- `publish_allowed` 和 `push_allowed` v1.5.5 默认均为 `false`。
- 服务器不调用 LLM，不修改 zloop 分析结论，只做格式转换、链接拼接和 outbox。
