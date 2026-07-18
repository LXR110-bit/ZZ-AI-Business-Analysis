---
name: AI小万数据读取 v1.6
description: AI 小万 v1.6 read 阶段 Skill：委托 xinghe-data-explore 执行 6 份聚合回收 Hive SQL，打包 raw_cache/read_result；不读写 AIWAN 服务器。
version: 1.6.9
---

# AI小万数据读取 v1.6

## 职责边界

本 Skill 只负责 `read` 阶段：**委托星河取数并固化原始结果包**。

履约两张明细表（`category_fulfill_daily_avg`、`category_fulfill_summary`）如果 SQL 与物化都成功但返回 0 行，只能降级为 `known_gaps` / `warn`，继续产出 raw_cache；不得把“空 CSV”误判为缺失文件或物化失败。非履约主表为空仍按 failed 处理。

必须做：

```text
加载 SQL/playbook -> 触发 xinghe-data-explore -> 打包 raw_cache -> 返回 read_result
```

禁止做：

- 禁止调用 AIWAN 服务器/APIHub read。
- 禁止调用 AIWAN 服务器/APIHub write。
- 禁止直连 Hive、One-Service、APIHub 网关或自行拼 Cookie/Authorization/X-API-Key。
- 禁止生成经营分析、归因、摘要或建议。
- 禁止做周日均、rolling/final、标签快照、服务器缓存加工；这些属于 process 阶段。

## Runtime Client Gate

- 唯一运行时数据能力：`xinghe`。
- 主路径必须**用 Skill 工具加载 `xinghe-data-explore` 执行取数**，禁止自取数。
- 本阶段只允许写本次运行的临时取数产物，例如 raw CSV、渲染 SQL、`raw_cache_<run_dt>.zip`、`active_fetch_manifest.json`。

## 沙箱执行策略

READ 阶段必须按受控并发执行，禁止一次性提交 6 个 Hive SQL：

```text
重 SQL 队列，并发 1：
- model_daily_avg
- model_summary

轻 SQL 队列，并发 2：
- category_daily_avg
- category_summary
- category_fulfill_daily_avg
- category_fulfill_summary

总体并发最多 3。
```

同一 `run_dt + rendered_sql_sha256` 下，若某 SQL 已成功生成 CSV，可复用该 CSV；复用前必须校验文件存在、bytes > 0、行数可读取，并记录 `csv_sha256`。`run_dt` 或 SQL hash 变化时禁止复用。

沙箱磁盘优先省空间：validate 写服务器成功后删除 read/process 中间大文件；read 失败时删除大 CSV/raw_cache，只保留极简诊断 JSON。

## 执行前必读

命中本 Skill 后必须读取：

```text
references/query-playbook.md
references/sql/category_daily_avg.sql
references/sql/category_summary.sql
references/sql/category_fulfill_daily_avg.sql
references/sql/category_fulfill_summary.sql
references/sql/model_daily_avg.sql
references/sql/model_summary.sql
```

`references/query-playbook.md` 是已确认口径，6 份 SQL 是唯一允许执行的 read 阶段 SQL 集合。不得现场发明新 SQL 替代这些模板。SQL 模板与本轮渲染后 SQL 是旧服务器 v1.5.5 数据处理链路的输入契约，必须完整保存，不能只保留摘要。

## 输入

```json
{
  "run_id": "loop-full-2026-W29-...",
  "week": "2026-W29",
  "stage": "read",
  "scope": {"type": "weekly", "category": null},
  "run_dt": "2026-07-12",
  "rerun": true,
  "rerun_reason": "..."
}
```

- `run_dt` 未提供时按当前自然日取任务运行日，格式必须是 `YYYY-MM-DD`。
- `data_end_date` 未提供时按 `run_dt - 1 day` 取完整数据截止日，格式必须是 `YYYY-MM-DD`。
- `week` 是验收/归档目标周，不能替代 SQL 日期占位；实际数据周必须从 SQL 结果的 `week_start_date` 或服务器上下文推导。
- `sql_scope` 默认为 `all`，必须执行 6 份 SQL。

## 日期占位符硬规则

必须区分“任务运行日”和“数据截止日”，禁止把所有日期占位符无脑替换成同一个值。

```text
run_dt = 任务运行日，例如 2026-07-16
data_end_date = 完整数据截止日，默认 run_dt - 1 day，例如 2026-07-15
out_file_suffix = 产物后缀，默认 run_dt
```

占位符替换规则：

- `${outFileSuffix}` → `out_file_suffix`，通常等于 `run_dt`。
- `${hiveconf:run_dt}` → `run_dt`，表示任务运行日。
- `${hiveconf:end_date}` → `data_end_date`，除非 SQL playbook 明确证明它表示运行日。
- `$bash{date +%Y-%m-%d -d '-1 day'}` → `data_end_date`。
- `${#date(0,0,-1):yyyy-MM-dd#}` → `data_end_date`。

如果 SQL 模板中出现其他带 `-1 day`、`date(0,0,-1)` 或“昨天”语义的宏，也必须替换为 `data_end_date`。若取数系统确认当天数据可用，必须在 `read_result.data_freshness` 中说明证明来源，否则默认使用 T-1 完整数据口径。

## 执行步骤

1. 解析 `run_id/week/run_dt/data_end_date/scope`；缺少 `run_dt` 时使用当前自然日，缺少 `data_end_date` 时使用 `run_dt - 1 day`。
2. 读取 `references/query-playbook.md` 和 6 份 `references/sql/*.sql`。
3. 按“日期占位符硬规则”和 playbook 替换 SQL 日期占位符，记录替换后的 SQL 与 sha256；特别校验 `-1 day` 宏不得被替换为 `run_dt`。
4. 用 Skill 工具加载 `$xinghe-data-explore`，按“沙箱执行策略”受控提交 6 份 Hive SQL；禁止一次性全部提交。
5. 等待每个 SQL 到终态；任一 SQL 失败时，本阶段 `status=failed`，停止交付成功包。
6. 每个 SQL 到 `SUCCESS` 后，必须通过 `xinghe-data-explore` 的完整结果落文件能力导出 CSV，例如 `materialize_result_file`。禁止只调用 `get_sql_results` 读取预览行后声称 read 成功；预览行只能用于日志抽查，不能作为 raw_cache 输入。
7. 将星河导出的 6 份 raw CSV 和渲染 SQL 放入同一 `input-dir`。
8. 必须保存完整 SQL 模板和本轮渲染后 SQL：
   - `references/sql/*.sql` 是随 Skill 发布的完整模板，不能只保留 SQL 名称或摘要。
   - 本轮执行时要把替换日期后的 SQL 保存到 `raw_cache/sql/<script>_<run_dt>.sql`。
   - `sql_status` 必须记录每份渲染 SQL 的 sha256，用于 process/validate 回溯。
9. 调用随包工具固化 fetch/read 契约：

```bash
node bin/package-raw-cache.js \
  --run-dt YYYY-MM-DD \
  --run-id <run_id> \
  --input-dir /path/to/xinghe_exports \
  --out-dir /path/to/read_artifacts
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

10. 轻量校验 `active_fetch_manifest.json`、`raw_cache_<run_dt>.zip`、`sql_status_<run_dt>.json`、`raw_manifest_<run_dt>.json` 均存在，且 raw_cache 内含 6 个 `raw/*.csv`。若 Loop artifacts 为空、raw_cache 不存在、或只有聊天摘要没有文件，本阶段必须返回 `status=failed`，错误码 `READ_ARTIFACTS_MISSING`。
11. 返回结构化 `read_result` 给主编排，由主编排立刻传给 process 阶段。

失败清理规则：

- 失败时必须写 `read_failed_diagnostic.json`，至少包含 run_id、run_dt、SQL 名、execute_id、状态、耗时、错误摘要、是否复用、row_count、sha256。
- 失败时删除 raw CSV、raw_cache、debug 下载文件等中间大文件。
- 若下次重跑时存在同一 `run_dt + rendered_sql_sha256` 的成功 CSV，可复用；否则只重跑失败、超时、缺失 CSV 或 SQL hash 变化的 SQL。

## 业务成功门禁

READ 阶段不得只因为 6 个 SQL execute_id 成功就返回业务成功。只有同时满足以下条件才允许 `status=success`：

- 6 个 SQL 均为 `SUCCESS`；
- 6 个 SQL 都已落成完整 CSV 文件，不是预览结果；
- SQL 执行遵守受控并发策略：重 SQL 并发 1、轻 SQL 并发 2、总并发不超过 3；
- `node bin/package-raw-cache.js` 执行成功；
- `active_fetch_manifest.json`、`raw_cache_<run_dt>.zip`、`sql_status_<run_dt>.json`、`raw_manifest_<run_dt>.json` 均存在；
- `raw_cache_<run_dt>.zip` 内含 6 个 `raw/*.csv` 和本轮渲染 SQL；
- `next_stage` 明确为 `process`。

任一条件不满足时返回 failed，不能用“READ 阶段完成，进入 PROCESS”作为最终输出。

## 输出

只返回给主编排，不写服务器：

```json
{
  "stage": "read",
  "status": "success|warn|failed",
  "output_type": "sql_result",
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "run_dt": "YYYY-MM-DD",
  "data_end_date": "YYYY-MM-DD",
  "data_freshness": {
    "run_dt": "YYYY-MM-DD",
    "data_end_date": "YYYY-MM-DD",
    "rule": "default_t_minus_1|source_verified_same_day",
    "warnings": []
  },
  "sql_scope": "all",
  "sql_scripts": [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
    "model_daily_avg",
    "model_summary"
  ],
  "artifacts": {
    "active_fetch_manifest": "active_fetch_manifest.json",
    "raw_cache": "raw_cache_<run_dt>.zip",
    "sql_status": "sql_status_<run_dt>.json",
    "raw_manifest": "raw_manifest_<run_dt>.json"
  },
  "sql_status": {},
  "row_counts": {},
  "warnings": [],
  "next_stage": "process"
}
```

失败时返回 `status=failed`、`error`、已完成 SQL 的状态；不要尝试写服务器。
