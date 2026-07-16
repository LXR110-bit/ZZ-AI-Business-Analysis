---
name: AI小万数据读取 v1.6
description: AI 小万 v1.6 read 阶段 Skill：委托 xinghe-data-explore 执行 6 份聚合回收 Hive SQL，打包 raw_cache/read_result；不读写 AIWAN 服务器。
version: 1.6.5
---

# AI小万数据读取 v1.6

## 职责边界

本 Skill 只负责 `read` 阶段：**委托星河取数并固化原始结果包**。

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

## 执行前必读

命中本 Skill 后必须读取：

```text
references/query-playbook.md
references/sql/category_daily_avg.sql
references/sql/category_summary.sql
references/sql/category_fulfill_daily_avg.sql
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

- `run_dt` 未提供时按 T-1 取数，格式必须是 `YYYY-MM-DD`。
- `week` 是下游归档周，不能替代 SQL 日期占位。
- `sql_scope` 默认为 `all`，必须执行 6 份 SQL。

## 执行步骤

1. 解析 `run_id/week/run_dt/scope`；缺少 `run_dt` 时使用 T-1。
2. 读取 `references/query-playbook.md` 和 6 份 `references/sql/*.sql`。
3. 按 playbook 替换 SQL 日期占位符，记录替换后的 SQL 与 sha256。
4. 用 Skill 工具加载 `$xinghe-data-explore`，逐个提交 6 份 Hive SQL。
5. 等待每个 SQL 到终态；任一 SQL 失败时，本阶段 `status=failed`，停止交付成功包。
6. 将星河导出的 6 份 raw CSV 和渲染 SQL 放入同一 `input-dir`。
7. 必须保存完整 SQL 模板和本轮渲染后 SQL：
   - `references/sql/*.sql` 是随 Skill 发布的完整模板，不能只保留 SQL 名称或摘要。
   - 本轮执行时要把替换日期后的 SQL 保存到 `raw_cache/sql/<script>_<run_dt>.sql`。
   - `sql_status` 必须记录每份渲染 SQL 的 sha256，用于 process/validate 回溯。
8. 调用随包工具固化 fetch/read 契约：

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

9. 轻量校验 `active_fetch_manifest.json`、`raw_cache_<run_dt>.zip`、`sql_status_<run_dt>.json`、`raw_manifest_<run_dt>.json` 均存在。
10. 返回结构化 `read_result` 给主编排，由主编排传给 `AI小万数据处理 v1.6`。

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
