---
name: 小万经营取数
description: AI 小万 v1.5.5 四阶段流水线第 1 阶段：只负责委托 xinghe-data-explore 执行聚合回收 Hive SQL，落 raw CSV、sql_status、raw_manifest、raw_cache 和 active_fetch_manifest；不做数据处理、不调用 LLM。
version: 0.1.2
---

# 小万经营取数

## 所属流程

本 Skill 是 AI 小万 4 Skill / 4 Loop 架构的第 1 阶段：

```text
Fetch/取数 → Process/数据处理 → Analyze/经营分析 → Validate/经营校验
```

本 Skill 只做 **Fetch/取数**，是下游「小万数据处理」的唯一上游输入来源。

## LLM 调用边界

本 Skill **不得调用** GLM-5.2、DeepSeek V4 Pro 或任何其他 LLM；不得生成经营洞察、归因、摘要或建议。

## Runtime Client Gate

- 唯一运行时数据能力：`xinghe`；主路径必须**用 Skill 工具加载 xinghe-data-explore**，取数方式必须触发 `xinghe-data-explore`，禁止自取数。
- 禁止自行直连 Hive、One-Service 或 API Hub；禁止手写 HTTP 网关鉴权、Cookie、Authorization、X-API-Key。
- 本阶段可写的只有本次取数产物文件与 manifest，不覆盖服务器 dashboard 缓存。

## 执行前必读

取数时必须加载：

```text
references/query-playbook.md
references/sql/category_daily_avg.sql
references/sql/category_summary.sql
references/sql/category_fulfill_daily_avg.sql
references/sql/category_fulfill_summary.sql
references/sql/model_daily_avg.sql
references/sql/model_summary.sql
```

SQL 骨架只用于生成 raw 结果。表头规范化、字段内逗号修复、Sheet5 提取、周日均、rolling/final、历史缓存合并、标签快照接入、server cache bundle 都由「小万数据处理」负责。

## 输入参数

默认参数：

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
  ],
  "output_raw_results": true,
  "upload_to_cloud": true,
  "stop_on_sql_error": true,
  "manifest_contract_version": "ai-wan-v1.5.5-fetch"
}
```

`run_dt` 格式必须是 `YYYY-MM-DD`。无人值守 Loop 未显式传参时使用 T-1；`sql_scope=all` 必须执行 6 份 SQL。

## 工作流

1. 解析 `run_dt`，默认执行日 T-1。
2. 生成 `run_id`，建议格式：`fetch_<run_dt>_<短随机串>`。
3. 读取 `references/query-playbook.md` 和 `references/sql/` 中 SQL 骨架。
4. 替换所有日期占位符为 `run_dt`，记录替换前后的 sha256；不得改写业务 SQL 口径。
5. 委托 `xinghe-data-explore` 执行 6 个 SQL，并记录每个执行任务的 `execute_id`。
6. 等待每个 SQL 到终态；若任一 SQL 非 `SUCCESS`，按失败处理并生成 failed `active_fetch_manifest.json`。
7. 将每个 SQL 原始结果落盘为 raw CSV，文件名建议：`raw/<script_name>_<run_dt>.csv`。
8. 对 raw CSV 只做文件完整性检查：存在、非空、可读取行数、列数、bytes、sha256；不要转换表头、不要日均归一化、不要去重合并。
9. 生成 `sql_status_<run_dt>.json`。
10. 生成 `raw_manifest_<run_dt>.json`。
11. 打包 `raw_cache_<run_dt>.zip`，zip 内必须包含 raw CSV、渲染后的 SQL、sql_status、raw_manifest。
12. 生成并保存 / 上传 `active_fetch_manifest.json`，供数据处理 Loop 读取。


## 可执行工具

本 Skill 随包提供确定性封装工具（不取数、不处理、不调用 LLM），用于把 `xinghe-data-explore` 已导出的 6 份 raw CSV 与渲染 SQL 固化为 Fetch 契约产物：

```bash
node bin/package-raw-cache.js \
  --run-dt YYYY-MM-DD \
  --input-dir /path/to/xinghe_exports \
  --out-dir /path/to/fetch_artifacts
```

`input-dir` 至少包含：

```text
category_daily_avg*.csv
category_summary*.csv
category_fulfill_daily_avg*.csv
category_fulfill_summary*.csv
model_daily_avg*.csv
model_summary*.csv
```

若同名 `.sql` 存在，工具会一并写入 `raw_cache/sql/`；否则写入占位 SQL 并在 manifest 保留执行事实。工具只做 row_count / column_count / sha256 完整性检查。

## raw_cache 目录结构

`raw_cache_<run_dt>.zip` 解压后必须满足：

```text
raw/
  category_daily_avg_<run_dt>.csv
  category_summary_<run_dt>.csv
  category_fulfill_daily_avg_<run_dt>.csv
  category_fulfill_summary_<run_dt>.csv
  model_daily_avg_<run_dt>.csv
  model_summary_<run_dt>.csv
sql/
  category_daily_avg_<run_dt>.sql
  category_summary_<run_dt>.sql
  category_fulfill_daily_avg_<run_dt>.sql
  category_fulfill_summary_<run_dt>.sql
  model_daily_avg_<run_dt>.sql
  model_summary_<run_dt>.sql
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
```

raw 文件可以保留星河原始表头和原始导出结构。若星河 model SQL 多语句只 materialize 首个结果集，本阶段仍原样记录执行事实，并在 `known_gaps` 标记 `model_sheet5_may_require_process_extraction`；不得在 Fetch 中自行补处理。

## sql_status 契约

`sql_status_<run_dt>.json` 至少包含：

```json
{
  "contract_version": "ai-wan-v1.5.5-fetch",
  "stage": "fetch",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "sql_scope": "all",
  "status": "success|failed",
  "scripts": {
    "category_daily_avg": {
      "execute_id": "",
      "status": "SUCCESS|FAILED|TIMEOUT",
      "row_count": 0,
      "column_count": 0,
      "raw_csv": "raw/category_daily_avg_<run_dt>.csv",
      "rendered_sql": "sql/category_daily_avg_<run_dt>.sql",
      "started_at": "",
      "finished_at": "",
      "error_summary": ""
    }
  },
  "generated_at": ""
}
```

## raw_manifest 契约

`raw_manifest_<run_dt>.json` 至少包含：

```json
{
  "contract_version": "ai-wan-v1.5.5-fetch",
  "stage": "fetch",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "target_month": "YYYY-MM",
  "files": {
    "category_daily_avg": {
      "path": "raw/category_daily_avg_<run_dt>.csv",
      "bytes": 0,
      "sha256": "",
      "row_count": 0,
      "column_count": 0,
      "source_headers": []
    }
  },
  "sql_status": "sql_status_<run_dt>.json",
  "raw_cache": "raw_cache_<run_dt>.zip",
  "known_gaps": [
    "board_metrics_feishu.csv pending in process/server cache",
    "headers/daily-average/history-cache are process-stage responsibilities"
  ],
  "generated_at": ""
}
```

## active_fetch_manifest 契约

`active_fetch_manifest.json` 是 Process 阶段的入口，必须指向**本次** raw 包，不得复用旧成功 manifest：

```json
{
  "contract_version": "ai-wan-v1.5.5-fetch",
  "stage": "fetch",
  "status": "success|failed",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "target_month": "YYYY-MM",
  "sql_scope": "all",
  "raw_cache": "raw_cache_<run_dt>.zip",
  "raw_cache_sha256": "",
  "sql_status": "sql_status_<run_dt>.json",
  "raw_manifest": "raw_manifest_<run_dt>.json",
  "scripts": [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
    "model_daily_avg",
    "model_summary"
  ],
  "script_status": {},
  "quality_gates": {
    "all_sql_success": true,
    "all_raw_csv_present": true,
    "raw_cache_sha256_present": true
  },
  "known_gaps": [],
  "generated_at": ""
}
```

## 与 Process 的责任边界

Fetch 必须明确不做以下事情：

- 不生成 `imports_<run_dt>.zip`、Excel、`processed_cache`、`server_cache_bundle`、`analysis_history`、`data_quality_report`。
- 不做 `day_cnt` / `daysReceived` 周日均归一化。
- 不判断 rolling/final，不维护 `KEEP_WEEKS=10`。
- 不读取或写入 `tags.json` / `tag-vocab.json` / category taxonomy 快照。
- 不生成服务器展示缓存格式。

## 成功判定

- 6 个 SQL 均为 `SUCCESS`；
- 6 个 raw CSV 均落盘并记录 bytes / sha256 / row_count / column_count；
- `sql_status_<run_dt>.json`、`raw_manifest_<run_dt>.json`、`raw_cache_<run_dt>.zip`、`active_fetch_manifest.json` 均生成；
- `active_fetch_manifest.status=success` 且 `raw_cache_sha256` 非空；
- 未调用 LLM，未输出经营洞察。

## 失败处理

任一 SQL 失败、raw CSV 无法落盘、manifest/sha256 失败时，本阶段 failed：

1. 仍生成 `sql_status` 和 failed `active_fetch_manifest`，写明失败 SQL、execute_id、错误摘要。
2. 若 raw_cache 不完整，`active_fetch_manifest.status=failed` 且不得指向旧 raw_cache。
3. 下游 Process 读取到 failed manifest 后必须停止，不得读旧数据继续处理。
