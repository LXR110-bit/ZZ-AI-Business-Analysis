---
name: AI小万数据处理 v1.6
description: AI 小万 v1.6/v1.7 process 阶段 Skill：消费 read 阶段 raw_cache，复用 v1.5.5 服务器加工语义，并读取飞书品类映射生成 processed_data。
version: 1.6.5
---

# AI小万数据处理 v1.6

## 职责边界

本 Skill 只负责 `process` 阶段：**把 read 阶段 raw SQL 结果处理成分析可消费的数据包**。

必须做：

```text
接收 read_result/raw_cache -> 运行确定性处理脚本 -> 生成 processed_data
```

禁止做：

- 禁止调用 AIWAN 服务器/APIHub read。
- 禁止调用 AIWAN 服务器/APIHub write。
- 禁止重新跑 SQL 或触发任何取数 Skill。
- 禁止调用 LLM 或生成 AI 归因/经营洞察。
- 禁止在 raw 数据不足时伪造趋势、标签或 board 指标。
- 禁止用“新版 v1.6 阶段简化”为理由跳过旧服务器数据逻辑；v1.6 只改变编排和最终写入方式，不改变数据加工口径。

## 执行前必读

命中本 Skill 后必须读取：

```text
references/model-tag-sync-contract.md
references/server-flow-mapping.md
references/category-mapping-contract.md
```

如需补齐服务器标签快照，还必须读取：

```text
references/server-snapshot/tags.json
references/server-snapshot/tag-vocab.json
references/server-snapshot/board_metrics_feishu.csv
```

## 输入

主编排必须传入上一步完整输出：

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "stage": "process",
  "read_result": {
    "stage": "read",
    "status": "success|warn",
    "output_type": "sql_result",
    "run_dt": "YYYY-MM-DD",
    "artifacts": {
      "active_fetch_manifest": "active_fetch_manifest.json",
      "raw_cache": "raw_cache_<run_dt>.zip"
    }
  },
  "scope": {"type": "weekly", "category": null}
}
```

`read_result.status` 只能是 `success|warn`；`failed` 必须停止。

## 执行步骤

1. 校验 `read_result.status` 为 `success|warn`，且 `active_fetch_manifest/raw_cache` 存在。
2. 读取 `references/model-tag-sync-contract.md`、`references/server-flow-mapping.md` 与 `references/category-mapping-contract.md`，确认字段、标签、缓存口径与品类映射规则。
3. 每次运行先读取飞书 Base「品类映射表」：
   - base token：`NKw4b2eKxaKhDTsOrD9cONklnGb`
   - table：`品类映射`
   - 字段：`三级品类`、`阶段`、`业务状态`、`二级板块`、`归类置信度`
   - 导出为 JSON 或 CSV 后传给处理脚本的 `--category-mapping-file`。
4. 若飞书读取失败，允许使用最近一次 `category_mapping.csv` / `category-mapping.json` 快照继续，但必须在 `warnings`、`data_quality_report.known_gaps` 和下游 `monitor` 标记 `category_mapping_source_not_realtime`。
5. 调用随包确定性处理工具：

```bash
node bin/process-raw-cache.js \
  --run-dt YYYY-MM-DD \
  --run-id <run_id> \
  --input-dir /path/to/read_artifacts \
  --out-dir /path/to/process_artifacts \
  --snapshot-dir references/server-snapshot \
  --category-mapping-file /path/to/category_mapping.json
```

如有上一轮 processed cache，可追加：

```bash
--previous-processed-cache /path/to/processed_cache_previous.zip
```

6. 处理时必须覆盖 v1.5.5 已验证语义；这些是验收基线，不是参考建议：
   - 表头规范化、字段内逗号修复、Sheet5 提取；
   - `day_cnt` / `daysReceived` 周日均归一化；
   - rolling/final 判定；
   - `KEEP_WEEKS=10` 历史缓存合并；
   - model/category/cache/server bundle 输出；
   - `tags.json`、`tag-vocab.json`、`board_metrics_feishu.csv` 快照接入；
   - `analysis_history`、`data_quality_report`、`active_process_manifest` 生成。
7. 处理品类映射：
   - `发展`、`孵化`、`种子` 进入聚合和 dashboard 分层；
   - `自营(非聚合)` 排除聚合/万象大盘分析；
   - `业务状态=已下线` 保留历史，不参与最新周环比；
   - 未匹配、`待归类`、`归类置信度=待你确认` 写入 `data_quality_report` 并传给 analyze/validate。
8. 将脚本结果包装为 v1.6 `processed_data`，返回主编排，由主编排传给 `AI小万经营分析 v1.6`。

## 输出

```json
{
  "stage": "process",
  "status": "success|warn|failed",
  "output_type": "processed_data",
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "run_dt": "YYYY-MM-DD",
  "metric_snapshot": {},
  "candidate_anomalies": [],
  "analysis_history": {},
  "model_tag_snapshot": {},
  "model_tag_knowledge": {},
  "server_cache_bundle": {},
  "category_mapping_manifest": {},
  "data_quality_report": {},
  "active_process_manifest": {},
  "process_summary": {},
  "warnings": [],
  "next_stage": "analyze"
}
```

若 `history_weeks` 不足 8 周、`board_metrics` 缺失、标签快照缺失或 SQL raw 行数异常，本阶段可以 `status=warn`，但必须在 `warnings` 与 `data_quality_report.known_gaps` 明确标记。失败时返回 `status=failed` 和 `error`，不要尝试写服务器。
