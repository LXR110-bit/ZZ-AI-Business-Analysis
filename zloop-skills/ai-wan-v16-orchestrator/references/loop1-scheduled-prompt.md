# Loop1 阶段 A 调度契约

每次 scheduled-agent 运行必须直接进入当前绑定的 `AI小万主编排 v1.6`，只执行一个 `aiwan_loop1_tick.py` tick；这不是 Loop 管理任务。

生产 job prompt 顶部必须放置最终输出硬约束：

```text
【最终输出硬约束】禁止在任何回复中输出 <think>、推理过程、执行计划或 Markdown 围栏。脚本返回 published/late_published 时，只输出一个原始 JSON 对象；如果 final_summary.json 存在，优先原样读取并输出该 JSON 的关键字段与 diagnostics 路径。
```

注意：若平台 persisted final_text 仍拼入 `<think>` 前缀，应归为平台/模型输出隔离问题；内容侧仍必须保留上述约束和 `final_summary.json` 旁路产物，方便平台剥离后直接消费。

## Job 绑定要求

- `skill_id` / `sandbox-type` 保持 `data-analysis-sandbox`。
- 必须设置 `preferred_skill_id=b28e30d2-b8c6-456f-888d-57c48785286f`（AI小万主编排 v1.6）。
- 运行模型必须显式记录为远端规范 ID `claude-sonnet-4-6[1m]`（Claude Sonnet 4.6）。Loop 当前没有服务端强制限制模型的可靠字段；Prompt 必须携带该 ID。若 Runtime 注入的 `ZLOOP_MODEL_ID` / `WORKBENCH_MODEL_ID` / `MODEL_ID` 与之不同，脚本以 `MODEL_PIN_MISMATCH` 失败；若 Runtime 未注入 model ID，产物必须标记 `verified=false` / `unverified_no_runtime_model_env`，禁止宣称已验证 pin。
- Prompt 首段必须明确：不要创建/提交/查询/等待 Loop，不要回复“Loop 已提交/正在排队执行”，不要触发 `zloop-loop` 管理意图。
- 入口目录优先用 Runtime 注入的 `ZLOOP_ACTIVE_SKILL_DIR`；未注入时从 Runtime 提供的 `CLAUDE_SKILLS_DIR` 根 + 固定 `preferred_skill_id` 确定性拼出（非搜索）。仍禁止 `find`/`locate`/递归 `ls` 猜位置；只有两者都拿不到、或目录/入口脚本不存在时才 5 秒内结构化失败。

## 动态日期与入口

使用 Asia/Shanghai 动态计算日期，不得在 Prompt 里硬编码 week 或日期。为避免 GNU/BSD `date` 差异，推荐用 Python 计算：

```bash
SKILL_DIR="${ZLOOP_ACTIVE_SKILL_DIR:-}"
if [ -z "$SKILL_DIR" ] && [ -n "${CLAUDE_SKILLS_DIR:-}" ]; then
  SKILL_DIR="$CLAUDE_SKILLS_DIR/b28e30d2-b8c6-456f-888d-57c48785286f"
fi
test -n "$SKILL_DIR" || { echo '{"ok":false,"error":{"code":"ACTIVE_SKILL_DIR_MISSING"}}'; exit 2; }
cd "$SKILL_DIR" || { echo '{"ok":false,"error":{"code":"ACTIVE_SKILL_DIR_INVALID"}}'; exit 2; }
test -f scripts/aiwan_loop1_tick.py || { echo '{"ok":false,"error":{"code":"SKILL_ENTRYPOINT_MISSING"}}'; exit 2; }
PYTHON_BIN="$(command -v python3 || command -v python || true)"
test -n "$PYTHON_BIN" || { echo '{"ok":false,"error":{"code":"PYTHON_MISSING"}}'; exit 2; }
eval "$($PYTHON_BIN - <<'PY'
from datetime import datetime, timedelta
try:
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
except Exception:
    now = datetime.utcnow() + timedelta(hours=8)
run_dt = now.date()
data_end = run_dt - timedelta(days=1)
iso = data_end.isocalendar()
print(f"RUN_DT='{run_dt.isoformat()}'")
print(f"DATA_END_DATE='{data_end.isoformat()}'")
print(f"WEEK='{iso.year}-W{iso.week:02d}'")
print(f"BASE_DEADLINE_AT='{run_dt.isoformat()}T07:10:00+08:00'")
PY
)"
BASE_REVISION="${BASE_REVISION:-1}"
"$PYTHON_BIN" scripts/aiwan_loop1_tick.py \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE" \
  --base-revision "$BASE_REVISION" \
  --base-deadline-at "$BASE_DEADLINE_AT"
```

- `run_id/analysis_key/worker_id` 由脚本稳定生成。
- `pending + exit 0` 表示本 tick 正常结束，当前 run 可以 30 秒后继续 poll，同一调度计划也应以 10 分钟节奏重复触发。
- `analyze_pending` 时由 scheduled-agent 先读取返回 JSON 的 `next_agent_action` / `analysis_payload`。`analyze_input.json` 是完整事实源，禁止压缩、裁剪或替换；脚本同时生成 `analysis_digest.json`、`analysis_categories_index.json`、`analysis_top_movers.json`、`analysis_category_shards/*.json`、`category_tail_hints.json` 作为非损耗导航产物。推荐先读 digest/index/top movers/tail hints，再按 index 分批读取 shard，必要时回到 `analyze_input.json.evidence_pack` 完整证据；然后分批写 `analysis_result.json`。写完后先运行 `python3 scripts/aiwan_loop1_tick.py --check-analysis-result --run-dir "$RUN_DIR" --fix-analysis-result`，自检通过再重跑同一 tick finalize。若本地路径不可读但 `analysis_payload` 存在，不得直接失败，先基于 payload 写 board/tiers/secondary 骨架并继续恢复；若返回 `error.code=ANALYZE_INPUT_MISSING`，重复同一 tick 让脚本从服务器 checkpoint 重建，仍失败则原样输出结构化错误。
- 写 `analysis_result.json` 时禁止手写超大 Python dict literal；中文文案内需要引用结构词时优先用 `「」`，避免英文双引号破坏脚本语法。`categories` 每个品类必须带受控标签之一：`高影响风险品类`、`明确机会品类`、`异常风险品类`、`低基数波动品类`、`稳健品类`。`history_weeks < 8` 时禁止写“8周趋势/10周趋势/长期趋势”，统一写“多周观察/多周表现/样本不足”。
- `analyze_input.json.model_pin.required_model_id` 必须等于 `claude-sonnet-4-6[1m]`；最终 `analysis_result_assembled.json.llm_policy.model` 必须保留同一值。
- 当前上线闭环固定 `model_enrichment_mode=disabled`，只验证 Loop1 基础发布。Loop2 / drilldown handoff 为预留能力，不作为本次发布成功条件，也不得由正式 Loop1 调度主动触发。
- 不得启用旧 full7 兼容入口代替本 Loop1 入口。
- 最终回复只能输出脚本最终 JSON / `final_summary.json` 的短摘要字段，禁止输出 `<think>`、推理过程、排障长文、完整 analyze 文案或大段 Markdown。诊断留存在 `artifacts_dir/final_summary.json` 与 `artifacts_dir/aiwan_loop1_diagnostics.json`，最终 JSON 只引用路径。
