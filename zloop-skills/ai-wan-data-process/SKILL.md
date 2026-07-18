---
name: 小万数据处理 v1.5.5
description: AI 小万 v1.5.5 四阶段流水线第 2 阶段：消费 Fetch raw_cache，复制旧服务器 refresh-dashboard-daily.sh 的数据处理语义，产出 imports、processed_cache、server_cache_bundle、analysis_history、data_quality_report 和 active_process_manifest；不调用 LLM。
version: 0.1.2
---

# 小万数据处理

## 所属流程

本 Skill 是 AI 小万 4 Skill / 4 Loop 架构的第 2 阶段：

```text
Fetch/取数 → Process/数据处理 → Analyze/经营分析 → Validate/经营校验
```

本 Skill 复制旧服务器数据处理主链路，不跑 SQL、不调用 LLM、不输出经营洞察。

## LLM 调用边界

本 Skill **不得调用** GLM-5.2、DeepSeek V4 Pro 或任何其他 LLM。所有表头映射、周日均、rolling/final、历史合并、质量门禁、server cache bundle 都必须是确定性规则处理。

## Runtime Client Gate

- 本 Skill 运行时决策：`none`。它只消费 Fetch 阶段已落盘/上传的文件产物。
- 禁止访问 Hive、One-Service、API Hub、dashboard API 或任何 LLM API。
- 禁止直接覆盖线上服务器目录；本阶段只生成可交付的数据包和 active manifest，由后续同步/部署环节决定是否发布。
- 读取 Fetch raw CSV 后必须执行确定性预处理：兼容 `cate_name_label`、`model_id_col`、`model_name_label`、`fulfill_type`、拼音指标列（如 `ji_kuang_uv` / `cheng_jiao_gmv`），并按“右侧指标列固定 + 左侧维度列反向合并”的策略修复未加引号的逗号机型名。

- 质量门禁中 WTD 大幅下滑需要区分低量噪声：当上一周基线低于低量阈值（GMV<1000、成交量<2、下单量<5、估价UV<20）时，ratio<0.5 只记 warn，不阻断 Process。
- 远端沙箱没有服务器 `/data` 时，允许使用 Skill 包内 `references/server-snapshot/` 的只读快照作为标签、board_metrics 的兜底输入；兜底快照只用于 dry-run 验证，后续生产应切换为 API/稳定 artifact。

## 旧服务器流程映射

旧服务器 `model-tag-monitor/scripts/refresh-dashboard-daily.sh` 的数据段语义必须在本阶段复制：

1. `validate-daily-import-coverage.js`：校验 staging imports 覆盖目标周、run_id、文件行数。
2. `check-wtd-quality.js`：校验当前 WTD 与 baseline 的异常回退、宽范围下滑、day_cnt 差异、category vs model reconciliation。
3. `promote-local-imports.js`：按 `week_start_date` 分区合并；同分区用本次 staging 覆盖，其他分区保留。
4. `sync-board-metrics-from-feishu.js` + `board-sync.js`：大盘/DAU/入口数据进入 `board-metrics.json`；当前没有上游 SQL 时输出空 cache + known_gap。
5. `/api/sync` 对应 `src/sync.js`：生成机型 `cache.json`，最近 `KEEP_WEEKS=10`，机型主粒度聚合，转化率/客单价重算。
6. `/api/sync/taxonomy` 对应 `src/taxonomy-sync.js`：生成/携带 `category-taxonomy.json`，过滤 `自营(非聚合)`。
7. `/api/sync/category` 对应 `src/category-sync.js`：生成 `category-cache.json`，表头归一、周日均、taxonomy 过滤、转化率重算。
8. `/api/sync/board` 对应 `src/board-sync.js`：生成 `board-metrics.json`，按周去重保留最近窗口。

详细字段契约见 `../../docs/AI小万_v1.5.5_数据处理契约.md`。


## 可执行工具

本 Skill 随包提供确定性 Process 工具（不跑 SQL、不访问 Hive/API Hub/dashboard API、不调用 LLM）：

```bash
node bin/process-raw-cache.js \
  --run-dt YYYY-MM-DD \
  --input-dir /path/to/fetch_artifacts \
  --out-dir /path/to/process_artifacts \
  --snapshot-dir /path/to/server_snapshots
```

输入目录必须有 `active_fetch_manifest.json` 和其指向的 `raw_cache_<run_dt>.zip`。可选 `--previous-processed-cache processed_cache_<prev>.zip`；未显式传入时工具会尝试从输入/输出目录的上一版 `active_process_manifest.json` 解析。

工具实现的固定链路：

```text
active_fetch_manifest + raw_cache
  → staging imports
  → processed imports (week_start_date 分区覆盖 + KEEP_WEEKS=10)
  → cache.json / category-cache.json / category-fulfill-cache.json / board-metrics.json
  → tags/tag-vocab/tag_snapshot_manifest + model_tag_snapshot/model_tag_knowledge
  → processed_cache / server_cache_bundle / analysis_history / data_quality_report / active_process_manifest
```

失败时仍会写出 `data_quality_report_<run_dt>.json` 和 failed `active_process_manifest.json`，且不会指向旧成功缓存。

## 输入要求

必须读取 Fetch 阶段产物：

```text
active_fetch_manifest.json
raw_cache_<run_dt>.zip
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
```

可选读取上一轮 Process 产物，用于历史合并：

```text
active_process_manifest.json
processed_cache_<previous_run_dt>.zip
server_cache_bundle_<previous_run_dt>.zip
```

可选读取服务器快照 / 人工配置快照：

```text
tags.json
tag-vocab.json
category_taxonomy.csv 或 category-taxonomy.json
board_metrics_feishu.csv
```

若标签或 taxonomy 快照缺失，不得失败；必须使用默认空/seed 口径并在 `data_quality_report` 标记 `tag_snapshot_missing` 或 `taxonomy_snapshot_missing`。

## 前置校验

处理前必须校验：

```text
active_fetch_manifest.contract_version == ai-wan-v1.5.5-fetch
active_fetch_manifest.stage == fetch
active_fetch_manifest.status == success
active_fetch_manifest.run_dt == 当前 run_dt
active_fetch_manifest.raw_cache_sha256 == sha256(raw_cache_<run_dt>.zip)
raw_manifest.run_id == active_fetch_manifest.run_id
6 个 raw CSV 均存在且 row_count > 0
```

校验失败时生成 failed `active_process_manifest.json` 和 `data_quality_report_<run_dt>.json`，下游 Analyze 不得读取旧缓存继续分析。

## 默认参数

```json
{
  "history_weeks": 10,
  "min_history_weeks_for_trend": 8,
  "dashboard_window_weeks": 2,
  "keep_weeks_policy": "KEEP_WEEKS=10",
  "stage_contract_version": "ai-wan-v1.5.5-process",
  "generate_imports": true,
  "generate_excel": true,
  "generate_processed_cache": true,
  "generate_server_cache_bundle": true,
  "generate_analysis_history": true,
  "generate_data_quality_report": true,
  "stop_on_raw_validation_error": true,
  "allow_board_metrics_gap": true,
  "allow_history_insufficient_warn": true
}
```

## 工作流

### Step 1：解包 raw_cache 并建立 staging imports

1. 解压 `raw_cache_<run_dt>.zip` 到只读 raw 工作目录。
2. 读取 `raw_manifest` 和 `sql_status`。
3. 将 raw CSV 转为 dashboard imports contract：
   - `category_daily_avg_YYYY-MM.csv`
   - `category_summary_YYYY-MM.csv`
   - `category_fulfill_daily_avg_YYYY-MM.csv`
   - `category_fulfill_summary_YYYY-MM.csv`
   - `model_daily_avg_YYYY-MM.csv`
   - `model_summary_YYYY-MM.csv`
4. 所有 imports CSV 第一列必须是 `week_start_date`，并保留可按 `week_start_date` 分区覆盖的形态。
5. model SQL 必须校验 / 提取 Sheet5 最细粒度：品类 × 机型 × 核心属性 × 成色 × 履约方式 × 周。若只有最细粒度，则需额外派生机型主粒度给旧服务器 `cache.json`。
6. 修复字段内逗号未转义导致的 model CSV 列数异常：按“右侧指标列和属性列固定，机型名称合并多余逗号段”的策略修复，只修结构不改字段值；记录 `csv_repair.fixed_rows`。

### Step 2：周日均与 rolling/final 处理

必须复制 `category-sync.js` / `sync.js` 的口径：

- `day_cnt`、`已收到天数`、`daysReceived` 统一映射为 `daysReceived`。
- 对 daily_avg 类缓存字段，如果来源表头不是显式日均（不含 `日均` / `daily_avg` / `avg_daily`）且 `daysReceived > 1`，则执行 `指标 / daysReceived`。
- 显式日均字段不得再次除以 `day_cnt`。
- 周汇总 imports 仅用于交付与对账；server cache 的日均指标来自 daily_avg 文件或等价归一化结果。
- 当前 rolling 周 `daysReceived = min(7, max(1, run_dt - week_start_date + 1))`。
- 已结束 final 周 `daysReceived = 7`。
- `week_start_date` 转 ISO week（如 `2026-W29`），并补齐：
  - `week`
  - `startDate = week_start_date`
  - `endDate = week_start_date + 6 days`
  - `rolling_status = rolling|final`
- 当 `daysReceived < 7` 时为 `rolling`；当 `daysReceived == 7` 或 `run_dt > endDate` 时为 `final`。

### Step 3：KEEP_WEEKS=10 历史缓存合并

本阶段必须恢复旧服务器 `KEEP_WEEKS=10` 能力：

1. 读取上一版 `active_process_manifest.json` 指向的 `processed_cache`（若存在）。
2. 将本次 staging imports 按 `week_start_date` 分区 promote 到 processed imports：同分区覆盖，其他分区保留，模拟 `promote-local-imports.js`。
3. 将 category / category_fulfill / model / board caches 按 grain + week + 维度 key 合并：
   - 当前 rolling 周：每天用最新 run_dt 覆盖；
   - 已结束 final 周：冻结，不被同一 run_dt 的空数据覆盖；
   - 同一 key 多版本：保留 `source_run_dt` 最新记录；
   - 保留最近 10 个 ISO week，超窗裁剪。
4. 若 history week 数 < 8，`data_quality_report.quality_gates.history_insufficient=warn`，Analyze 阶段只能做谨慎趋势分析。

### Step 4：标签快照与 taxonomy 接入

Process 必须把旧服务器展示所需的标签/分类配置纳入 `server_cache_bundle`：

- `tags.json`：按 v1.5 结构保留 `{ "category||modelName": { dimensions, tags, note } }`，兼容旧数组 tags；缺失时输出 `{}`。
- `tag-vocab.json`：保留 `core/lifecycle/price/custom` 维度；缺失时使用默认：`core=[核心,非核心,观察]`、`lifecycle=[新品,主流,长尾,淘汰]`、`price=[高价段,中价段,低价段]`。
- `category-taxonomy.json`：来自 `category_taxonomy.csv`、上一轮 cache 或 seed；`category-cache.json` 中必须过滤 `tier=自营(非聚合)`。
- `tag_snapshot_manifest.json` / `model_tag_sync_manifest_<run_dt>.json`：记录来源、sha256、row/key 数、API→file fallback、飞书摘要同步状态和 known_gaps。
- `model_tag_snapshot_<run_dt>.json`、`model_tag_knowledge_<run_dt>.json`、`model_tag_feishu_summary_<run_dt>.md`：由 `model-tag-monitor/scripts/export-model-tag-snapshot.js` 生成，Analyze 只读 `model_tag_knowledge`。

标签快照不是 LLM 生成；只能原样搬运、normalize 和校验。飞书知识库只写摘要，不回写 `tags.json`。

### Step 5：生成服务器展示缓存格式

生成 `server_cache_bundle_<run_dt>.zip`，让旧服务器解压到数据目录后可复用 dashboard 展示逻辑。zip 内至少包含：

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

核心格式：

- `cache.json` / `model-cache.json`：复制 `src/sync.js` 输出结构 `{ syncedAt, version, source, categories, weeks, rows }`；`rows` 为机型主粒度，保留 `jkuv/evaUv/orderUv/orderCnt/shipCnt/signCnt/qcCnt/dealCnt/returnCnt/gmv/avgPrice/evaRate/orderRate/shipRate/dealRate/returnRate/daysReceived/week/startDate/endDate/category/modelId/modelName`。
- `category-cache.json`：复制 `src/category-sync.js` 输出结构 `{ syncedAt, version, source, weeks, categories, rows }`；`rows` 过滤自营(非聚合)并重算 `evaRate/orderRate/shipRate/dealRate`。
- `category-fulfill-cache.json`：与 category 类似，但 grain 为 `category_fulfillment_daily_avg`，维度含 `fulfillmentMethod`。
- `board-metrics.json`：复制 `src/board-sync.js` 输出结构 `{ syncedAt, version, source, weeks, rows }`；当前无 `board_metrics_feishu.csv` 时输出空 rows、空 weeks 或可用历史 rows，并在 `known_gaps` 标记。
- `rolling-status.json`：记录每个 week 的 `startDate/endDate/daysReceived/status/source_run_dt`。
- `dashboard-source-manifest.json`：记录所有 cache 文件的 sha256、row_count、weeks、source_run_id、source_fetch_run_id。

### Step 6：生成 analysis_history

生成 `analysis_history_<run_dt>.json`，供 Analyze 阶段消费，不让 LLM 直接吃全量 Excel。至少包含：

```json
{
  "contract_version": "ai-wan-v1.5.5-analysis-history",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "weeks": [],
  "rolling_status": {},
  "category_history": [],
  "category_fulfill_history": [],
  "model_topn_history": [],
  "model_detail_contributor_candidates": [],
  "metric_baseline": {},
  "tag_dimensions_summary": {},
  "known_gaps": [],
  "quality_summary": {}
}
```

`analysis_history` 必须控制体积：保留最近 10 周、TopN contributor candidates 和必要 baseline，不放全量 4.7 万行明细给 LLM。

### Step 7：生成 data_quality_report

`data_quality_report_<run_dt>.json` 必须覆盖：

- upstream fetch 校验；
- 6 个 raw/imports 文件存在、行数、列数、表头规范化；
- `day_cnt` / `daysReceived` 合法性、rolling/final 判定；
- CSV 修复行数；
- WTD 质量门禁：异常回退、宽范围下滑、baseline 缺失、category vs model reconciliation；
- `KEEP_WEEKS=10` 合并结果和 history week 数；
- taxonomy 过滤和标签快照状态；
- board_metrics gap；
- quality gate 结论：`pass|warn|failed`。

## 产物

```text
imports_<run_dt>.zip
AI小万_聚合回收经营分析_<run_dt>.xlsx
manifest_<run_dt>.json
processed_cache_<run_dt>.zip
server_cache_bundle_<run_dt>.zip
analysis_history_<run_dt>.json
data_quality_report_<run_dt>.json
active_process_manifest.json
```

## processed_cache 内容

`processed_cache_<run_dt>.zip` 必须包含可继续滚动合并的状态：

```text
imports/
  category_daily_avg_YYYY-MM.csv
  category_summary_YYYY-MM.csv
  category_fulfill_daily_avg_YYYY-MM.csv
  category_fulfill_summary_YYYY-MM.csv
  model_daily_avg_YYYY-MM.csv
  model_summary_YYYY-MM.csv
  active.json
  manifests/manifest_<run_dt>.json
cache/
  cache.json
  model-cache.json
  category-cache.json
  category-fulfill-cache.json
  category-taxonomy.json
  board-metrics.json
  tags.json
  tag-vocab.json
state/
  rolling-status.json
  history-index.json
  tag_snapshot_manifest.json
  data_quality_report_<run_dt>.json
```

## active_process_manifest

```json
{
  "contract_version": "ai-wan-v1.5.5-process",
  "stage": "process",
  "status": "success|warn|failed",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "target_month": "YYYY-MM",
  "upstream_stage": "fetch",
  "upstream_run_id": "",
  "upstream_raw_cache": "raw_cache_<run_dt>.zip",
  "upstream_raw_cache_sha256": "",
  "history_weeks": 10,
  "history_weeks_available": 0,
  "min_history_weeks_for_trend": 8,
  "analysis_scope_hint": "trend_10w|wow_only",
  "dashboard_window_weeks": 2,
  "rolling_week": "YYYY-Www",
  "final_weeks": [],
  "imports_zip": "imports_<run_dt>.zip",
  "excel": "AI小万_聚合回收经营分析_<run_dt>.xlsx",
  "manifest": "manifest_<run_dt>.json",
  "processed_cache": "processed_cache_<run_dt>.zip",
  "processed_cache_sha256": "",
  "server_cache_bundle": "server_cache_bundle_<run_dt>.zip",
  "server_cache_bundle_sha256": "",
  "analysis_history": "analysis_history_<run_dt>.json",
  "analysis_history_sha256": "",
  "data_quality_report": "data_quality_report_<run_dt>.json",
  "data_quality_report_sha256": "",
  "model_tag_snapshot": "model_tag_snapshot_<run_dt>.json",
  "model_tag_snapshot_sha256": "",
  "model_tag_knowledge": "model_tag_knowledge_<run_dt>.json",
  "model_tag_knowledge_sha256": "",
  "model_tag_sync_manifest": "model_tag_sync_manifest_<run_dt>.json",
  "model_tag_sync_manifest_sha256": "",
  "model_tag_source": "model-tag-monitor-server-front-end-tags",
  "model_tag_stats": { "tagged_model_count": 0, "category_count": 0 },
  "feishu_sync": { "status": "not_configured", "write_mode": "summary_only_not_source_of_truth" },
  "artifact_hashes": { "analysis_history": "sha256", "model_tag_knowledge": "sha256", "model_tag_sync_manifest": "sha256" },
  "quality_gates": "pass|warn|failed",
  "warnings": [],
  "known_gaps": ["board_metrics_feishu.csv pending"],
  "generated_at": ""
}
```

## 成功判定

- 上游 Fetch manifest 校验通过；
- imports / Excel / manifest 生成；
- `processed_cache` 与 `server_cache_bundle` 生成且 sha256 非空；
- `analysis_history` 生成；
- `data_quality_report` 生成；
- `active_process_manifest` 更新为本次 run；
- 若只有 `history_insufficient` 或 `board_metrics_feishu.csv pending`，可以 `status=warn`，但必须写明 Analyze 降级策略；
- 未调用 LLM、未输出经营洞察。

## 失败处理

以下情况必须 `status=failed`：

- 上游 `active_fetch_manifest` failed、run_dt 不一致或 raw_cache sha256 不匹配；
- 6 个 raw 必要文件缺失；
- 表头无法规范化到 imports contract；
- `day_cnt` / rolling/final 无法判定；
- history cache 合并失败；
- `processed_cache` 或 `server_cache_bundle` 生成失败；
- `data_quality_report.quality_gates=failed`。

失败时仍需生成 failed `active_process_manifest.json` 和 `data_quality_report_<run_dt>.json`，但不得指向旧成功 processed cache。
