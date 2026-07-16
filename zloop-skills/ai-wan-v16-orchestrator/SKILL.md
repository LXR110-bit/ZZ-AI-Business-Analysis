---
name: AI小万主编排 v1.6
description: AI 小万 v1.6/v1.7 单 Loop 入口 Skill：串联 read SQL 取数、process 品类映射与模板处理、analyze 生成 display_insights、validate 最终写服务器。
version: 1.6.18
---

# AI小万主编排 v1.6

## Loop 入口约束

Loop 只选择本 Skill。主编排必须在**本 Skill 单次运行内**完成四阶段，不得通过 `$AI小万数据读取 v1.6`、`$AI小万数据处理 v1.6`、`$AI小万经营分析 v1.6`、`$AI小万结果校验 v1.6` 切换到子 Skill。

远端 zloop 的 `$Skill` 激活会让子 Skill 接管整轮 assistant 响应，无法可靠返回主编排。因此 Loop 入口必须使用本包内置模块执行：

```text
scripts/aiwan_inline_state_machine.py
→ read 内联模块：references/read/* + $xinghe-data-explore + raw_cache
→ process 内联模块：bin/process-raw-cache.js + references/process/*
→ analyze 内联模块：references/analyze/* + scripts/aiwan_apihub.py read
→ validate 内联模块：references/validate/* + scripts/aiwan_apihub.py write/read
```

执行前必须读取：

- `references/api-playbook.md`
- `references/apihub-read-write-contract.md`

## 运行入口（必须先执行）

命中本 Skill 后，第一步必须运行包内状态机脚本，不能先用自然语言模拟四阶段，也不能只完成 READ 后总结：

```bash
python scripts/aiwan_inline_state_machine.py \
  --run-id <run_id> \
  --week <week> \
  --run-dt <run_dt> \
  --data-end-date <data_end_date>
```

状态机脚本负责真实执行 `read → process → analyze → validate → server write/reread`。脚本退出码非 0 或输出 `ok=false` 时，最终必须报告业务失败；禁止把 Loop 平台 `succeeded` 当成业务成功。

最终答复必须优先复述脚本输出的 `aiwan_inline_result.json`，而不是重新组织一份只含 READ 的摘要。

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
| read | 本包 `references/read/*` | 禁止读取/写入服务器；必须委托 `xinghe-data-explore` | run_id/week/run_dt/data_end_date/scope | `read_result` / `sql_result` / `raw_cache` |
| process | 本包 `bin/process-raw-cache.js` | 禁止读取/写入服务器；禁止重新跑 SQL；读取飞书品类映射或快照 | `read_result` + `raw_cache` | `processed_data` + `category_mapping_manifest` |
| analyze | 本包 `references/analyze/*` | 只允许读取服务器上下文 | `processed_data` + server context | `analysis_result`，含 `findings` + `display_insights` |
| validate | 本包 `references/validate/*` | 校验后最终写入服务器并复读确认 | `processed_data` + `analysis_result` | `validation_result` |

## 全局硬约束

1. 主编排必须在同一次 invocation 内连续推进 `read → process → analyze → validate`。
2. 禁止调用四个阶段子 Skill；它们只是版本化模块来源，不是 Loop 运行入口。
3. 禁止把 `read/process/analyze` 任一阶段摘要作为最终答复。
4. 只有 `validate` 完成最终服务器写入并复读确认后，才允许宣称完整闭环成功。
5. 如果任一阶段失败，必须停止后续阶段，并输出失败阶段、失败原因、可重跑建议；不要伪造后续阶段。
6. `read` 和 `process` 阶段禁止调用服务器/APIHub；如果它们尝试这么做，视为职责错误。
7. `analyze` 阶段只读服务器，不写服务器。
8. `validate` 阶段负责最终写服务器，payload 必须包含 `processed_data`、`analysis_result`、`validation_result`。
9. `read` 阶段必须触发 `$xinghe-data-explore` 执行 6 份已确认 SQL，并返回 `raw_cache/active_fetch_manifest/sql_status/raw_manifest`。6 个 execute_id 成功但未落成 raw CSV/raw_cache 时仍视为 `failed`。
10. `process` 阶段必须消费 read 阶段产物，运行确定性 process pipeline；不得把 read 的 raw SQL 结果直接传给 analyze。
11. `process` 阶段必须产出 `category_mapping_manifest`；飞书品类映射读取失败时允许用最近快照，但必须把非实时风险传给 analyze/validate。
12. `analyze` 阶段必须产出 `analysis_result.display_contract=dashboard-business-overview-insights-map/v1` 和完整 `display_insights`；服务器 bridge 不会从 findings 生成页面文案。
13. `validate` 阶段必须校验 `display_insights` 后再写服务器；display 不合法时 `publish_allowed=false`。
14. 如果 assistant 准备输出最终答复，但 `stage_results.process/analyze/validate` 任一缺失，必须立刻停止最终答复，继续调用下一个阶段 Skill。
15. Loop 平台 `succeeded` 不等于业务成功；只有 `validation_result.server_write_confirmed=true` 且复读确认包含同一 `run_id`，才能把 `overall_status` 标为 `success|warn`。

## 单次调用内循环协议

Loop 模式下优先执行机器状态机，而不是手写分阶段对话：

```bash
python scripts/aiwan_inline_state_machine.py \
  --run-id "$RUN_ID" \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE"
```

该脚本必须完整执行 read → process → analyze → validate，并把最终 JSON 作为本 Skill 的最终答复依据。脚本 exit code 非 0 时，必须把 `aiwan_inline_result.json` 或 stderr 中的失败阶段、错误码和 artifacts_dir 返回给 Loop，不能改写成成功。

```text
stage_order = [read, process, analyze, validate]

read_result = execute embedded read module
if read_result.status failed: stop
if read_result.next_stage == process: immediately call process in the same response turn

processed_data = execute embedded process module with read_result
if processed_data.status failed: stop
if processed_data.next_stage == analyze: immediately call analyze in the same response turn

analysis_result = execute embedded analyze module with processed_data
if analysis_result.status failed: stop
if analysis_result.next_stage == validate: immediately call validate in the same response turn

validation_result = execute embedded validate module with processed_data + analysis_result
if validation_result.server_write_confirmed true: final success/warn report
else: final failed report
```

执行阶段时不得通过 `$` 调用 AI小万阶段 Skill。只有 `read` 阶段允许通过 `$xinghe-data-explore` 委托 SQL 取数，因为它是底层取数能力而不是 AIWAN 阶段 Skill。

### 阶段继续执行门禁

每个阶段完成后，先做下面的门禁，而不是总结给用户：

```text
if current_stage == read and read_result.next_stage == "process":
  execute embedded process module immediately

if current_stage == process and processed_data.next_stage == "analyze":
  execute embedded analyze module immediately

if current_stage == analyze and analysis_result.next_stage == "validate":
  execute embedded validate module immediately
```

禁止在 read 阶段之后输出类似“返回 read_result 给主编排”“下一步 process”的最终消息后结束运行。此类文本只能是内部进度，不是最终答复。最终答复必须来自 validate 阶段之后。

## 子 Skill 调用要求

### 1. READ

执行本包 read 内联模块：

- 只跑 SQL。
- 必须读取 `references/read/query-playbook.md` 和 6 份 `references/read/sql/*.sql`。
- 必须委托 `$xinghe-data-explore`，不得自取数。
- 必须区分 `run_dt` 与 `data_end_date`；`-1 day` 日期宏默认替换为 `data_end_date=run_dt-1 day`。
- 必须用 `$xinghe-data-explore` 的完整结果落文件能力把 6 个 SQL 结果导出为 CSV；禁止只用 `get_sql_results` 预览行作为 raw_cache 输入。
- 必须调用 `node bin/package-raw-cache.js --run-dt ... --run-id ... --input-dir ... --out-dir ...` 打包 read 产物。
- 继续 process 前必须检查 `active_fetch_manifest.json`、`raw_cache_<run_dt>.zip`、`sql_status_<run_dt>.json`、`raw_manifest_<run_dt>.json` 均存在，且 raw_cache 内含 6 个 `raw/*.csv`。
- 不读服务器。
- 不写服务器。
- 返回包含 `raw_cache/active_fetch_manifest/sql_status/raw_manifest` 的 `read_result`。

如果 6 个 SQL 已成功但没有 raw_cache 文件，必须返回：

```json
{"stage":"read","status":"failed","error":{"code":"READ_ARTIFACTS_MISSING"}}
```

禁止在这种情况下输出 `overall_status=success|warn`，也禁止让 Loop 平台 `succeeded` 掩盖业务失败。

### 2. PROCESS

执行本包 process 内联模块，并传入完整 `read_result`：

- 只按 process pipeline 处理 read 阶段 raw_cache。
- 必须读取 `references/process/model-tag-sync-contract.md`、`references/process/server-flow-mapping.md`、`references/process/category-mapping-contract.md`。
- 必须调用 `node --max-old-space-size=${AIWAN_PROCESS_NODE_OLD_SPACE_MB:-8192} bin/process-raw-cache.js --run-dt ... --run-id ... --input-dir ... --out-dir ... --snapshot-dir references/process/server-snapshot --category-mapping-file ...`，避免 `model_summary` / `model_daily_avg` 大 CSV 在远端默认 Node 堆下 OOM。
- validate 写服务器时必须显式传 `output_type: "validation_result"`，避免服务器默认 `validate_result` 兼容路径影响 bridge 判断。
- 调用前必须确认 process 的 `--input-dir` 内有 READ 生成的 `active_fetch_manifest.json` 和 `raw_cache_<run_dt>.zip`；缺失时返回 failed，错误码 `PROCESS_INPUT_MISSING`，不得重新跑 SQL 或编造 processed_data。
- 必须产出 `metric_snapshot/candidate_anomalies/analysis_history/model_tag_knowledge/category_mapping_manifest/data_quality_report`。
- 不读服务器。
- 不写服务器。
- 不重新跑 SQL。
- 返回 `processed_data`。

### 3. ANALYZE

执行本包 analyze 内联模块，并传入完整 `processed_data`：

- 必须读取 `references/analyze/evidence-contract.md`、`references/analyze/display-insights-contract.md`、`references/analyze/five-layer-analysis-method.md`、`references/analyze/model-adaptation.md`、`references/analyze/model-tag-knowledge-contract.md`、`references/analyze/insights-schema.json`。
- 需要读取服务器上下文。
- 通过 `python scripts/aiwan_apihub.py read --run-id "$RUN_ID" --stage analyze --week "$WEEK" --history-weeks 10 --include run_meta,history_10w,rules,previous_stage_outputs,dashboard_snapshot` 读取。
- 结合 `processed_data` + server context 生成分析。
- 必须返回 `findings` 用于追溯，并返回 `display_insights` 作为旧 dashboard 页面主产物。
- `display_insights` 必须包含 `board`、`tiers.发展/孵化/种子`、`secondaryCategories`、`categories`、`category`、`monitor`、`warnings`。
- 不写服务器。
- 返回 `analysis_result`。

### 4. VALIDATE

执行本包 validate 内联模块，并传入完整 `processed_data` 与 `analysis_result`：

- 必须读取 `references/validate/display-insights-contract.md`、`references/validate/insights-schema.json`、`references/validate/model-tag-validation-contract.md`。
- 校验数据和分析结果。
- 校验 `display_contract/display_insights` 是否满足服务器 bridge 发布契约。
- 把最终数据、分析结果、校验结果写入服务器。
- 通过 `python scripts/aiwan_apihub.py write ...` 写入，并通过 read 复读确认。
- 写后复读确认。
- 返回 `validation_result`。

## 最终输出

必须包含：

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "business_run_id": "<server/business run id if returned>",
  "actual_data_week": {
    "input_week": "2026-W29",
    "week_start_dates": [],
    "current_week_start": "YYYY-MM-DD",
    "data_end_date": "YYYY-MM-DD"
  },
  "stage_results": {
    "read": {"status": "...", "output_type": "sql_result"},
    "process": {"status": "...", "output_type": "processed_data"},
    "analyze": {"status": "...", "output_type": "analysis_result"},
    "validate": {"status": "...", "output_type": "validation_result", "server_write_confirmed": true}
  },
  "server_write_response": {},
  "overall_status": "success|warn|failed",
  "publish_allowed": true,
  "checks": [],
  "warnings": []
}
```

四阶段未完成或 validate 未写入服务器确认时，`overall_status=failed`、`publish_allowed=false`。
