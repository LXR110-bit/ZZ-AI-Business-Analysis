# AI 小万 v1.5.5 数据处理契约

## 目标

将 AI 小万 zloop Fetch + Process 数据链路对齐旧服务器 `model-tag-monitor` 的数据处理语义：

```text
raw_cache → imports → processed_cache → server_cache_bundle → analysis_history → active_process_manifest
```

Fetch 只跑 Hive SQL raw 取数；Process 才复制旧服务器处理逻辑。Fetch 和 Process 均禁止调用 LLM。

## 端到端产物

| 阶段 | 必要产物 | 用途 |
| --- | --- | --- |
| Fetch | `raw_cache_<run_dt>.zip` | 6 份 SQL 原始结果、渲染 SQL、sql_status、raw_manifest |
| Fetch | `active_fetch_manifest.json` | Process 入口；只指向本次成功 raw_cache |
| Process | `imports_<run_dt>.zip` / Excel / `manifest_<run_dt>.json` | 对账与人工查看；兼容旧 dashboard imports |
| Process | `processed_cache_<run_dt>.zip` | 可滚动合并的 10 周历史状态 |
| Process | `server_cache_bundle_<run_dt>.zip` | 服务器展示缓存，可解压到旧服务数据目录 |
| Process | `analysis_history_<run_dt>.json` | Analyze 阶段确定性证据历史，避免 LLM 读取全量明细 |
| Process | `data_quality_report_<run_dt>.json` | 质量门禁和降级依据 |
| Process | `active_process_manifest.json` | Analyze 入口；只指向本次 processed/cache/history |

## Fetch 契约

Fetch 输出 raw，不做处理。`raw_cache_<run_dt>.zip` 解压结构：

```text
raw/*.csv
sql/*.sql
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
```

`active_fetch_manifest.json` 必须包含：

```json
{
  "contract_version": "ai-wan-v1.5.5-fetch",
  "stage": "fetch",
  "status": "success|failed",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "target_month": "YYYY-MM",
  "raw_cache": "raw_cache_<run_dt>.zip",
  "raw_cache_sha256": "",
  "sql_status": "sql_status_<run_dt>.json",
  "raw_manifest": "raw_manifest_<run_dt>.json"
}
```

## Process 输入契约

Process 必须校验：

1. Fetch manifest stage/status/run_dt/sha256。
2. 6 个 raw CSV 存在且 row_count > 0。
3. `raw_manifest.run_id == active_fetch_manifest.run_id`。
4. 若上一轮 processed cache 存在，版本必须可识别；不可识别则从本次数据启动并标记 `history_insufficient`。

## imports contract

| 输出 | 必要表头 |
| --- | --- |
| `category_daily_avg_YYYY-MM.csv` | `week_start_date,品类名称,day_cnt,机况uv,估价uv,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv` |
| `category_summary_YYYY-MM.csv` | 同上，可省略 `day_cnt` |
| `category_fulfill_daily_avg_YYYY-MM.csv` | `week_start_date,品类名称,履约方式（只取线上流程）,day_cnt,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv` |
| `category_fulfill_summary_YYYY-MM.csv` | 同上，可省略 `day_cnt` |
| `model_daily_avg_YYYY-MM.csv` | `week_start_date,品类名称,机型id,机型名称,day_cnt,机况uv,估价uv,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv,核心属性（估价）,成色等级（估价）,品类名称.1,机型id.1,核心属性（质检）,成色等级（质检）,履约方式（只取线上流程）` |
| `model_summary_YYYY-MM.csv` | 同上，可省略 `day_cnt` |

所有 CSV 第一列必须是 `week_start_date`，用于模拟 `promote-local-imports.js` 的分区覆盖。

## day_cnt 周日均规则

字段映射：

```text
day_cnt / 已收到天数 / daysReceived → daysReceived
```

算法：

1. 从 `week_start_date` 和 `run_dt` 计算 `expected_days = min(7, max(1, diff_days(run_dt, week_start_date) + 1))`。
2. daily_avg 输入若有 `day_cnt`，使用文件值，但必须在 1..7；缺失时用 `expected_days`。
3. final 周统一 `daysReceived=7`。
4. 指标字段是否除以 days：
   - 来源表头包含 `日均` / `daily_avg` / `avg_daily`：不除；
   - 来源表头不显式日均且 `daysReceived > 1`：除以 `daysReceived`；
   - `daysReceived <= 1`：不除。
5. 重算派生指标：
   - `avgPrice = gmv / dealCnt`（dealCnt 为 0 时 0 或 null，保持旧 sync.js 口径）
   - `evaRate = evaUv / jkuv`
   - `orderRate = orderUv / evaUv`
   - `shipRate = shipCnt / evaUv`
   - `dealRate = dealCnt / evaUv`
   - `returnRate = returnCnt / qcCnt`（model cache）

## rolling/final 规则

```text
startDate = week_start_date
endDate = week_start_date + 6 days
week = ISOWeek(startDate)
```

- `daysReceived < 7` 且 `run_dt <= endDate`：`rolling`。
- `daysReceived == 7` 或 `run_dt > endDate`：`final`。
- rolling 周每天可覆盖。
- final 周冻结，除非同一周历史被明确重跑且数据质量 pass；否则不得被空数据覆盖。

## KEEP_WEEKS=10 历史合并

Process 必须维护 10 周窗口：

1. 当前 Fetch raw 通常覆盖当前周 + 上周。
2. 其余历史从上一轮 `processed_cache` 读取。
3. 合并 key：
   - category：`week||category`
   - category_fulfill：`week||category||fulfillmentMethod`
   - model main：`week||category||modelId/modelName`
   - model detail：`week||category||modelId/modelName||evalCore||evalCondition||qcCore||qcCondition||fulfillmentMethod`
   - board：`week`
4. 同 key 保留最新 `source_run_dt`。
5. 裁剪为最近 10 个 ISO week。
6. `history_weeks_available < 8` 时 quality gate 为 warn：`history_insufficient`。

## server_cache_bundle 格式

zip 内文件：

```text
cache.json
model-cache.json
category-cache.json
category-fulfill-cache.json
category-taxonomy.json
board-metrics.json
tags.json
tag-vocab.json
tag_snapshot_manifest.json
rolling-status.json
dashboard-source-manifest.json
```

### cache.json / model-cache.json

```json
{
  "syncedAt": "ISO8601",
  "version": "1.5.5-zloop",
  "source": {
    "dir": "processed_cache/imports",
    "prefix": "model_daily_avg_",
    "grain": "model_main_daily_avg",
    "targetWeeks": []
  },
  "categories": [],
  "weeks": [],
  "rows": []
}
```

`rows` 字段至少包含：`week/startDate/endDate/daysReceived/category/modelId/modelName/jkuv/evaUv/evaCnt/orderUv/orderCnt/shipCnt/signCnt/qcCnt/dealCnt/returnCnt/gmv/avgPrice/evaRate/orderRate/shipRate/dealRate/returnRate`。

### category-cache.json

```json
{
  "syncedAt": "ISO8601",
  "version": "1.5.5-zloop",
  "source": {
    "dir": "processed_cache/imports",
    "prefix": "category_daily_avg_",
    "targetWeeks": [],
    "grain": "daily_slice_category_dedup_daily_avg",
    "evaUv": "daily-slice category-level deduplicated UV sum"
  },
  "weeks": [],
  "categories": [],
  "rows": []
}
```

`rows` 需过滤 taxonomy 中 `tier=自营(非聚合)` 的品类。

### category-fulfill-cache.json

与 category cache 类似，`source.grain=category_fulfillment_daily_avg`，rows 维度增加 `fulfillmentMethod`。

### board-metrics.json

```json
{
  "syncedAt": "ISO8601",
  "version": "1.5.5-zloop",
  "source": { "prefixes": ["board_metrics", "board_metrics_feishu"], "targetWeeks": [] },
  "weeks": [],
  "rows": []
}
```

若无 `board_metrics_feishu.csv`，可以 rows 为空或使用上一轮历史 rows，但必须在 manifest/quality report 标记 `board_metrics_feishu.csv pending`。

## 标签快照

`tags.json` v1.5：

```json
{
  "品类||机型名称": {
    "dimensions": { "core": "核心", "lifecycle": "主流", "price": "高价段" },
    "tags": ["核心", "主流", "高价段"],
    "note": ""
  }
}
```

`tag-vocab.json`：

```json
{
  "core": ["核心", "非核心", "观察"],
  "lifecycle": ["新品", "主流", "长尾", "淘汰"],
  "price": ["高价段", "中价段", "低价段"],
  "custom": {}
}
```

缺失标签快照时输出空 tags + 默认 vocab，不用 LLM 补标签。

## data_quality_report

推荐结构：

```json
{
  "contract_version": "ai-wan-v1.5.5-quality",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "status": "pass|warn|failed",
  "upstream_fetch": {},
  "raw_import_coverage": {},
  "csv_repair": {},
  "day_cnt": {},
  "rolling_status": {},
  "history": { "keep_weeks": 10, "weeks_available": 0, "history_insufficient": false },
  "wtd_quality": {},
  "taxonomy": {},
  "tag_snapshot": {},
  "board_metrics": {},
  "known_gaps": [],
  "warnings": [],
  "errors": []
}
```

## active_process_manifest

必须只指向本次产物：

```json
{
  "contract_version": "ai-wan-v1.5.5-process",
  "stage": "process",
  "status": "success|warn|failed",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "upstream_run_id": "",
  "history_weeks": 10,
  "history_weeks_available": 0,
  "processed_cache": "processed_cache_<run_dt>.zip",
  "server_cache_bundle": "server_cache_bundle_<run_dt>.zip",
  "analysis_history": "analysis_history_<run_dt>.json",
  "data_quality_report": "data_quality_report_<run_dt>.json",
  "quality_gates": "pass|warn|failed",
  "known_gaps": []
}
```
