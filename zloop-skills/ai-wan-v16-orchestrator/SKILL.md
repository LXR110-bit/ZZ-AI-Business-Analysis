---
name: AI小万主编排 v1.6
description: AI 小万 v1.6/v1.7 主编排：阶段 A 以 4 SQL Loop1 通过 jobs/read+jobs/write 跨 tick 发布基础分析，并保留 full6 兼容入口。
version: 1.6.29
api_dependencies:
  - 2a56c817-134d-409a-b457-9ecf859217eb
  - d2d9e941-7662-4361-9ad8-f73d38cbd92b
---

# AI小万主编排 v1.6

## 执行模式

正式阶段 A Loop 使用 `scripts/aiwan_loop1_tick.py`，每次调度只执行一个 tick。analyze 阶段**由本沙箱主 agent（Claude Sonnet）亲自撰写**，不是确定性模板：

```text
tick(base):  4 个基础 SQL submit/poll → 服务器 checkpoint → process → 落确定性 evidence → 返回 analyze_pending
  ↓
agent(Claude): 读 analyze_input.json，按「AI小万经营分析 v1.6」的 rubric + few-shot 分批写 display_insights → 落 analysis_result.json
  ↓
tick(finalize): current_stage==analyze → 机器闸门校验 agent 产物 → validate 写服务器 → base_published → ready handoff
```

- 每个 `execute_id` 提交后立即 CAS 到服务器；SQL 未完成 tick 返回 `business_status=pending` 并退出 0。
- **`business_status=analyze_pending` 时（read+process 已完成、`analyze_input.json` 已生成）**：agent 必须立刻读取 `analyze_input.json`（其中 `evidence_pack` 是确定性数字来源），加载 `AI小万经营分析 v1.6` 的 `analyze-parity-rubric.md` + `golden-fewshot.md`，**分批**（board+三层一次；categories 每 20–30 个一批）产出 `display_insights`，把结果写到 `analysis_result.json` 的 `display_insights` 字段；数字只能来自 evidence_pack，禁止编造；随后**再跑一次 `aiwan_loop1_tick.py`** 进入 finalize。
- finalize tick 的机器闸门校验 schema/三层齐全/品类覆盖/带数/受控标签；不合规返回 `retryable_failed`，**不退回模板、不静默通过**。
- `run_id/analysis_key/worker_id` 必须按 `week + data_end_date + base_revision` 跨 tick 稳定，不得带本次执行时间或随机串。
- 阶段 A 固定 `model_enrichment_mode=disabled`，dashboard 发布状态为 `base_published`，交接任务不启动 Loop2 SLA。

`scripts/aiwan_inline_state_machine.py` 仅作为 full6 兼容入口，仍在同一次运行内完成：

```text
read（星河 SQL）→ process（确定性处理）→ analyze（只读服务器上下文）→ validate（最终写入并复读）
```

不得通过 `$AI小万数据读取 v1.6`、`$AI小万数据处理 v1.6`、`$AI小万经营分析 v1.6`、`$AI小万结果校验 v1.6` 切换阶段。四阶段由包内 `scripts/aiwan_inline_state_machine.py` 统一执行。

## 输入

只接收业务参数，不接收或校验物理 SkillVersion 路径：

```json
{
  "run_id": "<required-or-week-weekly>",
  "week": "YYYY-Www",
  "run_dt": "YYYY-MM-DD",
  "data_end_date": "YYYY-MM-DD",
  "base_revision": 1
}
```

- Loop1 未提供 `run_id` 时使用 `loop1-<week>-<data_end_date>-r<base_revision>`；full6 兼容入口仍使用显式 `run_id`。
- `run_id` 只能包含 `0-9 A-Z a-z . _ : -`；连续非法字符替换为 `_`。
- 未提供 `data_end_date` 时使用 `run_dt - 1 day`。
- 同一次运行中 `run_id/week/run_dt/data_end_date` 不得漂移。

## 阶段 A Loop1 固定入口

命中本 Skill 后立即运行下列入口。正常路径不要预读 reference，也不要用自然语言模拟四阶段：

```bash
test -n "${ZLOOP_ACTIVE_SKILL_DIR:-}" || {
  echo '{"ok":false,"error":{"code":"ACTIVE_SKILL_DIR_MISSING"}}'
  exit 2
}

cd "$ZLOOP_ACTIVE_SKILL_DIR" || {
  echo '{"ok":false,"error":{"code":"ACTIVE_SKILL_DIR_INVALID"}}'
  exit 2
}

test -f scripts/aiwan_loop1_tick.py || {
  echo '{"ok":false,"error":{"code":"SKILL_ENTRYPOINT_MISSING"}}'
  exit 2
}

PYTHON_BIN="$(command -v python3 || command -v python || true)"
test -n "$PYTHON_BIN" || {
  echo '{"ok":false,"error":{"code":"PYTHON_MISSING"}}'
  exit 2
}

"$PYTHON_BIN" scripts/aiwan_loop1_tick.py \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE" \
  --base-revision "${BASE_REVISION:-1}" \
  --base-deadline-at "$BASE_DEADLINE_AT"
```

调度 Prompt 必须动态计算 Asia/Shanghai 的 `RUN_DT/DATA_END_DATE/WEEK`，并把同一分析版本的 60 分钟截止时间稳定传入 `BASE_DEADLINE_AT`。配置时必须读取 `references/loop1-scheduled-prompt.md`。入口变量或文件缺失时必须在 5 秒内失败，禁止降级搜索。

## full6 兼容入口

```bash
"$PYTHON_BIN" scripts/aiwan_inline_state_machine.py \
  --run-id "$RUN_ID" \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE"
```

## 快速预检

只检查入口、依赖、6 份 SQL、build marker 与输出目录，不执行 SQL、不调用 APIHub、不生成业务结果：

```bash
cd "$ZLOOP_ACTIVE_SKILL_DIR"
PYTHON_BIN="$(command -v python3 || command -v python || true)"
test -n "$PYTHON_BIN" || { echo '{"ok":false,"error":{"code":"PYTHON_MISSING"}}'; exit 2; }
"$PYTHON_BIN" scripts/aiwan_inline_state_machine.py --preflight --json
```

预检目标耗时小于 3 秒。`ok=false` 时原样返回稳定错误码，不得继续完整运行。

## 全局硬约束

1. 禁止使用 `find`、`locate` 或递归 `ls` 搜索本 Skill。
2. 禁止探测 `/mnt/skill`、workspace、HOME 或 `/tmp` 来猜安装位置。
3. 禁止通过物理路径或 `versions/<version-id>` 判断 SkillVersion；版本选择由平台的 follow-current / pin-version 绑定负责。
4. Skill 内部路径一律相对 `ZLOOP_ACTIVE_SKILL_DIR`；脚本内部资源一律基于 `__file__` 解析。
5. 取数方式（必须触发）：用 Skill 工具加载 `xinghe-data-explore` 作为唯一底层取数能力，并遵循其已确认 SQL/异步执行契约；禁止自取数、直连 Hive/One-Service 或自行拼认证信息。Loop1 只允许 4 份基础 SQL，full6 兼容入口为 6 份。
6. read/process 禁止读写 AIWAN 服务器；analyze 只读；validate 才能最终写入并复读。
7. process 使用 v30 的流式 Python pipeline，禁止回退到会在 4GB 沙箱 OOM 的全量 Node pipeline。
8. `analysis_result.display_contract` 必须为 `dashboard-business-overview-insights-map/v1`，且 `display_insights` 完整。
9. 只有 validate 返回 `server_write_confirmed=true` 且复读命中同一 `run_id`，业务才可成功。
10. 任一阶段失败立即停止，禁止让 Loop 平台 `succeeded` 掩盖业务失败。

## 成功与失败判定

- Loop1 待续：`business_status=pending`且退出 0，等待下一 tick 从服务器状态恢复。
- Loop1 成功：基础四阶段通过、dashboard 复读命中同版本、base job 为 `published`，且 handoff 为 `ready`。
- full6 成功：四阶段均有结果、`publish_allowed=true`、`server_write_confirmed=true`。
- 告警成功：满足成功条件，但 read/process/analyze 存在非阻断 warning。
- 失败：脚本退出码非 0、`ok=false`、阶段缺失、validate 未确认写入或复读不一致。

最终答复优先复述 `aiwan_inline_result.json`，不得重新组织成只含 READ 的摘要。失败时原样返回错误码、失败阶段和 `artifacts_dir`。

## 故障路由（仅命中错误时读取）

- SQL、物化、raw_cache 或数据周问题：读取 `references/read/query-playbook.md`。
- Loop1 jobs API、CAS、租约、SQL checkpoint、发布复读或 handoff 问题：读取 `references/loop1-control-plane-contract.md`。
- process、品类映射、标签同步或 OOM 问题：读取 `references/process/server-flow-mapping.md`、`references/process/category-mapping-contract.md`、`references/process/model-tag-sync-contract.md`。
- analyze 展示、证据、五层分析、模型适配或标签知识问题：读取 `references/analyze/evidence-contract.md`、`references/analyze/display-insights-contract.md`、`references/analyze/five-layer-analysis-method.md`、`references/analyze/model-adaptation.md`、`references/analyze/model-tag-knowledge-contract.md`。
- validate、标签校验、APIHub write/reread 问题：读取 `references/validate/display-insights-contract.md`、`references/validate/model-tag-validation-contract.md`、`references/apihub-read-write-contract.md`。
- 需要核对完整四阶段调用契约时：读取 `references/api-playbook.md`。

未命中故障不要预读这些 reference。

## 最终输出

```json
{
  "ok": true,
  "run_id": "<same-run-id>",
  "week": "YYYY-Www",
  "entrypoint_resolution_mode": "runtime_active_skill_dir",
  "orchestrator_build": "v1.6.26-loop1-phase-a-python-process",
  "actual_data_week": {
    "input_week": "YYYY-Www",
    "week_start_dates": ["YYYY-MM-DD", "YYYY-MM-DD"],
    "current_week_start": "YYYY-MM-DD",
    "data_end_date": "YYYY-MM-DD"
  },
  "stage_results": {
    "read": {"status": "...", "output_type": "sql_result"},
    "process": {"status": "...", "output_type": "processed_data"},
    "analyze": {"status": "...", "output_type": "analysis_result"},
    "validate": {"status": "...", "output_type": "validation_result", "server_write_confirmed": true}
  },
  "timings": {
    "startup_seconds": 0.0,
    "preflight_seconds": 0.0,
    "read_seconds": 0.0,
    "process_seconds": 0.0,
    "analyze_seconds": 0.0,
    "validate_seconds": 0.0,
    "total_seconds": 0.0
  },
  "overall_status": "success|warn|failed",
  "publish_allowed": true,
  "checks": [],
  "warnings": [],
  "artifacts_dir": "..."
}
```

四阶段未完成或 validate 未确认写入时，`overall_status=failed`、`publish_allowed=false`。
