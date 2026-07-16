---
name: AI小万主编排 v1.6
description: AI 小万 v1.6/v1.7 单 Loop 入口 Skill：串联 read SQL 取数、process 品类映射与模板处理、analyze 生成 display_insights、validate 最终写服务器。
version: 1.6.5
---

# AI小万主编排 v1.6

## Loop 入口约束

Loop 只选择本 Skill。阶段 Skill 只能由本 Skill 在同一次运行中通过 `$` 顺序调用：

```text
$AI小万数据读取 v1.6
→ $AI小万数据处理 v1.6
→ $AI小万经营分析 v1.6
→ $AI小万结果校验 v1.6
```

执行前必须读取：

- `references/api-playbook.md`
- `references/apihub-read-write-contract.md`

## 输入

```json
{
  "run_id": "<required-or-week-weekly>",
  "week": "2026-W29",
  "start_stage": "read",
  "end_stage": "validate",
  "scope": {"type": "weekly", "category": null},
  "rerun": false,
  "rerun_reason": null
}
```

未提供 `run_id` 时使用 `<week>-weekly`。同一次运行中 `run_id/week` 不得变化。

### run_id 规范

`run_id` 只能包含后端允许字符：`0-9 A-Z a-z . _ : -`。

- 如果 Loop prompt 或用户输入的 `run_id` 含 `+`、空格、中文或其他非法字符，必须在调用阶段 Skill 前规范化：把连续非法字符替换为 `_`。
- 禁止把带 `+0800` 的时间戳直接作为 `run_id`；必须改成 `_0800` 或省略时区符号。
- 规范化后的 `run_id` 必须贯穿四阶段，禁止中途漂移。

## 新阶段职责契约（v1.6.5）

APIHub 不再是每阶段 checkpoint 中心。四阶段职责如下：

| 阶段 | Skill | 服务器/APIHub 使用 | 输入 | 输出 |
|---|---|---|---|---|
| read | `$AI小万数据读取 v1.6` | 禁止读取/写入服务器；必须委托 `xinghe-data-explore` | run_id/week/run_dt/scope | `read_result` / `sql_result` / `raw_cache` |
| process | `$AI小万数据处理 v1.6` | 禁止读取/写入服务器；禁止重新跑 SQL；读取飞书品类映射或快照 | `read_result` + `raw_cache` | `processed_data` + `category_mapping_manifest` |
| analyze | `$AI小万经营分析 v1.6` | 只允许读取服务器上下文 | `processed_data` + server context | `analysis_result`，含 `findings` + `display_insights` |
| validate | `$AI小万结果校验 v1.6` | 校验后最终写入服务器并复读确认 | `processed_data` + `analysis_result` | `validation_result` |

## 全局硬约束

1. 主编排必须在同一次 invocation 内连续推进 `read → process → analyze → validate`。
2. 禁止把 `read/process/analyze` 任一子 Skill 的返回文本作为最终答复。
3. 子 Skill 返回“阶段完成 / 返回主编排 / next_stage=...”只是 `continue` 信号。
4. 只有 `validate` 完成最终服务器写入并复读确认后，才允许宣称完整闭环成功。
5. 如果任一阶段失败，必须停止后续阶段，并输出失败阶段、失败原因、可重跑建议；不要伪造后续阶段。
6. `read` 和 `process` 阶段禁止调用服务器/APIHub；如果它们尝试这么做，视为职责错误。
7. `analyze` 阶段只读服务器，不写服务器。
8. `validate` 阶段负责最终写服务器，payload 必须包含 `processed_data`、`analysis_result`、`validation_result`。
9. `read` 阶段必须触发 `$xinghe-data-explore` 执行 6 份已确认 SQL，并返回 `raw_cache/active_fetch_manifest/sql_status/raw_manifest`。
10. `process` 阶段必须消费 read 阶段产物，运行确定性 process pipeline；不得把 read 的 raw SQL 结果直接传给 analyze。
11. `process` 阶段必须产出 `category_mapping_manifest`；飞书品类映射读取失败时允许用最近快照，但必须把非实时风险传给 analyze/validate。
12. `analyze` 阶段必须产出 `analysis_result.display_contract=dashboard-business-overview-insights-map/v1` 和完整 `display_insights`；服务器 bridge 不会从 findings 生成页面文案。
13. `validate` 阶段必须校验 `display_insights` 后再写服务器；display 不合法时 `publish_allowed=false`。

## 单次调用内循环协议

```text
stage_order = [read, process, analyze, validate]

read_result = call $AI小万数据读取 v1.6
if read_result.status failed: stop

processed_data = call $AI小万数据处理 v1.6 with read_result
if processed_data.status failed: stop

analysis_result = call $AI小万经营分析 v1.6 with processed_data
if analysis_result.status failed: stop

validation_result = call $AI小万结果校验 v1.6 with processed_data + analysis_result
if validation_result.server_write_confirmed true: final success/warn report
else: final failed report
```

每次通过 `$` 调用阶段 Skill 时，必须显式说明：子 Skill 只是阶段执行器，完成后返回结构化摘要；不要声明整条 Loop 已完成，不要要求用户另起一次 Loop。

## 子 Skill 调用要求

### 1. READ

调用 `$AI小万数据读取 v1.6`，并明确：

- 只跑 SQL。
- 必须委托 `xinghe-data-explore`，不得自取数。
- 必须读取 query-playbook 和 6 份 SQL 模板。
- 不读服务器。
- 不写服务器。
- 返回包含 `raw_cache/active_fetch_manifest/sql_status/raw_manifest` 的 `read_result`。

### 2. PROCESS

调用 `$AI小万数据处理 v1.6`，并传入完整 `read_result`，明确：

- 只按 process pipeline 处理 read 阶段 raw_cache。
- 必须产出 `metric_snapshot/candidate_anomalies/analysis_history/model_tag_knowledge/category_mapping_manifest/data_quality_report`。
- 不读服务器。
- 不写服务器。
- 不重新跑 SQL。
- 返回 `processed_data`。

### 3. ANALYZE

调用 `$AI小万经营分析 v1.6`，并传入完整 `processed_data`，明确：

- 需要读取服务器上下文。
- 结合 `processed_data` + server context 生成分析。
- 必须返回 `findings` 用于追溯，并返回 `display_insights` 作为旧 dashboard 页面主产物。
- `display_insights` 必须包含 `board`、`tiers.发展/孵化/种子`、`secondaryCategories`、`categories`、`category`、`monitor`、`warnings`。
- 不写服务器。
- 返回 `analysis_result`。

### 4. VALIDATE

调用 `$AI小万结果校验 v1.6`，并传入完整 `processed_data` 与 `analysis_result`，明确：

- 校验数据和分析结果。
- 校验 `display_contract/display_insights` 是否满足服务器 bridge 发布契约。
- 把最终数据、分析结果、校验结果写入服务器。
- 写后复读确认。
- 返回 `validation_result`。

## 最终输出

必须包含：

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "stage_results": {
    "read": {"status": "...", "output_type": "sql_result"},
    "process": {"status": "...", "output_type": "processed_data"},
    "analyze": {"status": "...", "output_type": "analysis_result"},
    "validate": {"status": "...", "output_type": "validation_result", "server_write_confirmed": true}
  },
  "overall_status": "success|warn|failed",
  "publish_allowed": true,
  "checks": [],
  "warnings": []
}
```

四阶段未完成或 validate 未写入服务器确认时，`overall_status=failed`、`publish_allowed=false`。
