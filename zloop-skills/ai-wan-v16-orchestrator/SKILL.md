---
name: AI小万主编排 v1.6
description: AI 小万 v1.6/v1.7 主编排：以 5 SQL Loop1（含 DAU/回收入口 UV）跨 tick 发布基础分析；SQL tick 并发提交保留，Loop2 机型下钻为预留能力，不纳入当前上线闭环。
version: 1.6.52
api_dependencies:
  - 2a56c817-134d-409a-b457-9ecf859217eb
  - d2d9e941-7662-4361-9ad8-f73d38cbd92b
  - f3f2a89f-3c54-4f3d-92a0-04d2a25a6b8d
  - c7af7d71-d114-44f4-87ac-8d225ad0b6c4
---

# AI小万主编排 v1.6

## 激活后硬约束

一旦本 Skill 被 Loop / scheduled-agent / `$AI小万主编排 v1.6` 命中，本 Skill 即为当前轮次的 active root orchestrator：

- 不得把本 Skill 仅当参考材料后自行改写流程；必须持续遵守本文件状态机，直到 `business_status=published/late_published` 或结构化失败。
- 不得创建、提交、查询、等待或取消 Loop；不得回复“Loop 已提交/正在排队/稍后通知”这类 Loop 管理话术。
- `business_status=analyze_pending` 后必须继续本文件 analyze 阶段：优先读取返回 JSON 的 `next_agent_action` / `analysis_payload`，再读取 `analyze_input.json` 完整证据；如果文件路径暂时不可读但 `analysis_payload` 存在，不得直接结束，先按 payload 写 `analysis_result.json` 骨架并继续恢复证据。
- 如果返回 `error.code=ANALYZE_INPUT_MISSING`，说明当前沙箱缺少本地分析交接文件；不要编造分析，重复运行同一个 `aiwan_loop1_tick.py` tick 让脚本基于服务器 SQL checkpoint 重建，若仍失败则原样输出结构化错误。
- analyze 完成后必须再次运行 `scripts/aiwan_loop1_tick.py` finalize；不得把 `analyze_pending` 误判为成功发布。

## 执行模式

正式阶段 A Loop 使用 `scripts/aiwan_loop1_tick.py`，每次调度只执行一个 tick。analyze 阶段**由本沙箱主 agent 按规范模型 `claude-sonnet-4-6[1m]` / Claude Sonnet 4.6 亲自撰写**，不是确定性模板：

```text
tick(base):  5 个基础 SQL（4 个品类 + sqldau）submit/poll → 服务器 checkpoint → process → 落确定性 evidence → 返回 analyze_pending
  ↓
agent(Claude): 读 analyze_input.json，按「AI小万经营分析 v1.6」的 rubric + few-shot 分批写 display_insights → 落 analysis_result.json
  ↓
tick(finalize): current_stage==analyze → 机器闸门校验 agent 产物 → validate 写服务器 → base_published
```

- 每个 `execute_id` 提交后立即 CAS 到服务器；SQL 未完成 tick 返回 `business_status=pending` 并退出 0。
- Loop 当前没有服务端强制限制模型的可靠字段；脚本会把规范模型 `claude-sonnet-4-6[1m]` 写入 `analyze_input.json.model_pin` 和 `analysis_result_assembled.json.llm_policy`。Runtime 如暴露了不同 model ID，必须以 `MODEL_PIN_MISMATCH` 失败；如 Runtime 未暴露 model ID，则产物标记 `verified=false` / `unverified_no_runtime_model_env`，禁止把它宣称为已验证 pin。
- **`business_status=analyze_pending` 时（read+process 已完成、`analyze_input.json` 已生成）**：agent 必须立刻读取返回 JSON 的 `next_agent_action` 和 `analysis_payload`。`analyze_input.json` 仍是完整事实源，不允许压缩或丢证据；为降低扫大 JSON 的失误，脚本会同时生成 `analysis_digest.json`、`analysis_categories_index.json`、`analysis_top_movers.json`、`analysis_category_shards/*.json`、`category_tail_hints.json`。写作顺序：先读 digest/index/top movers/tail hints 和对应 shard，再按需回读 `analyze_input.json.evidence_pack` 完整证据。加载 `AI小万经营分析 v1.6` 的 `analyze-parity-rubric.md` + `golden-fewshot.md`，**分批**（board+三层一次；categories 每 20–30 个一批）产出 `display_insights`，把结果写到 `analysis_result.json` 的 `display_insights` 字段；数字只能来自 digest/evidence_pack/analysis_payload/support_artifacts，禁止编造；gmv 已是日均口径（元/天），daysReceived 只表示数据完整性，禁止再除以 daysReceived；board/三层/板块直接引用 digest，禁止逐个品类加总或用 cur/prev 反推；品类文案必须带受控标签之一：`高影响风险品类`、`明确机会品类`、`异常风险品类`、`低基数波动品类`、`稳健品类`；`history_weeks < 8` 时禁止写 `8周趋势`、`10周趋势`、`长期趋势`，统一写“多周观察/多周表现”。写文件禁止手写超大 Python dict literal，避免中文文案中的英文引号造成 SyntaxError；若需要引用“量升价降”等结构，优先使用中文引号 `「」`。
- 写完 `analysis_result.json` 后，先运行本地自检：`python3 scripts/aiwan_loop1_tick.py --check-analysis-result --run-dir "$RUN_DIR" --fix-analysis-result`。自检 `ok=true` 后**再跑一次 `aiwan_loop1_tick.py`** 进入 finalize；若自检失败，按 `errors` 修改 `analysis_result.json`，不要直接撞 validate。
- finalize tick 会先执行确定性 pre-lint：仅替换禁用主观词、短历史禁词、补齐 board/三层闸门触发词并落 `analysis_result_autofix.json`；随后机器闸门校验 schema/三层齐全/品类覆盖/带数/受控标签。不合规返回 `retryable_failed`，**不退回模板、不静默通过**。若服务器已在 `validating/validate`，失败分支保留该状态并写结构化错误，不再尝试非法 `validating -> analyzing` 回滚。
- Loop1 process 阶段数据质检分层：`DATA_INTEGRITY_*` 等数据完整性问题继续硬拦；WTD ratio < 0.5 这类真实经营波动只进入 `warnings` / 分析证据，不得把 `quality_gates` 置为 failed，也不得阻断 analyze/validate/publish。
- `run_id/analysis_key/worker_id` 必须按 `week + data_end_date + base_revision` 跨 tick 稳定，不得带本次执行时间或随机串。
- SQL tick 并发提交是执行策略，不是“并发上线”：Loop1 每个 tick 最多保持 2 条活跃 SQL，用于在远端排队压力和总时长之间折中。
- 当前上线闭环只包含 Loop1 基础发布；`model_enrichment_mode` 固定按 `disabled` 处理，Loop2/`drilldown` handoff 仅作为预留能力，不作为发布成功条件，也不触发当前线上链路。
- 保命数据门：若 `category_daily_avg/category_summary` 或 process 后 `category-cache` 出现“`jkuv/evaUv` 非零但 `orderUv/orderCnt/shipCnt/signCnt/qcCnt/dealCnt/gmv` 全 0”，必须标记 `DATA_INTEGRITY_ORDER_CHAIN_EMPTY`，禁止复用 CSV、禁止 publish，并以 retryable/pending 方式等待订单分区就绪。
- analyze/finalize 跨 tick 前必须续租并刷新 `state_revision`，避免长分析后 lease 过期造成 `analyzing -> validating` 的 409/CAS；API Hub 包装的 `HUB_UPSTREAM_ERROR + upstream_status=409` 一律视为控制面状态冲突，而不是业务逻辑失败。
- `base_deadline_at` 只用于 SLA 观测：过期后标记 `base_delayed` 并告警，但原 revision 仍可 claim/state/validate/publish；晚发布记录 `publication_status=late_published`，不得因 deadline 强制升 revision。
- 必须升 `base_revision` 时，先读取旧 revision 的成功 SQL checkpoint；仅当 `analysis_key/week/data_end_date`、SQL SHA256、CSV 文件 SHA256 全部一致且文件仍存在时继承，任一不一致即按 cache miss 正常提交 SQL，禁止盲用旧数据。
- validate 必须携带 process 产出的 `publication_bundle`；服务器先完整校验基础缓存与洞察，再以 `dashboard.json` 最后落盘的方式发布，确保页面不会出现“job 已 published、静态 dashboard 仍停留旧日期”。

`scripts/aiwan_inline_state_machine.py` 仅作为 full7 兼容入口，仍在同一次运行内完成：

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

- Loop1 未提供 `run_id` 时使用 `loop1-<week>-<data_end_date>-r<base_revision>`；full7 兼容入口仍使用显式 `run_id`。
- `run_id` 只能包含 `0-9 A-Z a-z . _ : -`；连续非法字符替换为 `_`。
- 未提供 `data_end_date` 时使用 `run_dt - 1 day`。
- 同一次运行中 `run_id/week/run_dt/data_end_date` 不得漂移。
- SQL 模板日期语义固定：`${outFileSuffix}` 与 `$bash{date +%Y-%m-%d -d '-1 day'}` 都代表 `data_end_date`（T-1 数据分区/昨日），不是让 agent 读取沙箱当前日期或自行改写 SQL；订单表统一按 T-1 分区跑，早跑数据未就绪只由 `DATA_INTEGRITY_ORDER_CHAIN_EMPTY` 保命门拦截。

## 阶段 A Loop1 固定入口

命中本 Skill 后立即运行下列入口。正常路径不要预读 reference，也不要用自然语言模拟四阶段：

```bash
# 优先用 Runtime 注入的 ZLOOP_ACTIVE_SKILL_DIR；未注入时，从 Runtime 提供的
# CLAUDE_SKILLS_DIR 根 + 固定 preferred_skill_id 确定性拼出目录（非搜索，不猜位置）。
SKILL_DIR="${ZLOOP_ACTIVE_SKILL_DIR:-}"
if [ -z "$SKILL_DIR" ] && [ -n "${CLAUDE_SKILLS_DIR:-}" ]; then
  SKILL_DIR="$CLAUDE_SKILLS_DIR/b28e30d2-b8c6-456f-888d-57c48785286f"
fi
test -n "$SKILL_DIR" || {
  echo '{"ok":false,"error":{"code":"ACTIVE_SKILL_DIR_MISSING"}}'
  exit 2
}

cd "$SKILL_DIR" || {
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

调度 Prompt 必须动态计算 Asia/Shanghai 的 `RUN_DT/DATA_END_DATE/WEEK`，并把同一分析版本的 60 分钟截止时间稳定传入 `BASE_DEADLINE_AT`。配置 scheduled-agent job 时必须读取 `references/loop1-scheduled-prompt.md`，并设置 `preferred_skill_id=b28e30d2-b8c6-456f-888d-57c48785286f` 指向本主编排；Prompt 首段必须声明“不是 Loop 管理任务”，禁止创建/提交/查询 Loop 或回复“Loop 已提交/正在排队”。入口目录按“`ZLOOP_ACTIVE_SKILL_DIR` 优先，缺失时用 `CLAUDE_SKILLS_DIR/<preferred_skill_id>` 确定性拼出”解析：这是从 Runtime 提供的根目录拼路径，不是搜索；仍禁止 `find`/`locate`/递归 `ls` 猜位置。只有两者都拿不到、或拼出的目录/入口脚本不存在时，才在 5 秒内结构化失败。

## full7 兼容入口

```bash
"$PYTHON_BIN" scripts/aiwan_inline_state_machine.py \
  --run-id "$RUN_ID" \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE"
```

## 阶段 B Loop2 机型下钻预留入口

Loop2 机型下钻当前不纳入上线闭环。下面入口仅保留为预留能力和后续验证材料；正式 Loop1 调度不得因为存在下钻候选而触发 Loop2，也不得把 handoff 状态作为基础发布成功条件。若后续单独启用，需另起发布计划、真实 trial-run 和服务器写入验证。

若后续创建独立 Loop2 scheduled-agent job，推荐固定启动时间设为 **07:00 Asia/Shanghai**：当前 Loop1 生产 job 为 06:10，2026-07-21 完整执行实测约 40 分钟，07:00 给出约 10 分钟 buffer。固定时间只作调度 buffer，不作为可启动证明；Loop2 tick 启动后必须二次读取同 `analysis_key/base_revision` 的 base job，只有 Loop1 已 `published` / `publication_status=late_published` / `deliveryState=base_published|late_published` 才允许 claim handoff 和提交机型 SQL。若 base 仍为 running/pending/validating/retryable_failed/未找到，Loop2 必须返回 `pending`，原因标记 `base_not_published:*` 或 `base_job_not_found`，不得抢跑、不得重触发 Loop1。

```text
tick(read):  领取 drilldown 交接单 → 仅对下钻品类渲染 model_summary/model_daily_avg（注入 cate_name in(...)）
             → 机型 SQL 异步 submit（单条推进，机型 SQL 重、排队瓶颈）/ 跨 tick poll → 服务器 checkpoint
             → materialize → process（候选收敛：核心机型 ∪ GMV Top-N ∪ 环比异动机型）→ 返回 analyze_pending
  ↓
agent(Claude): 读 model_analyze_input.json（candidate_models 为本期 SQL 数字来源；server_history_context
             只用于多周趋势、上一期结论和版本对齐），按机型归因 rubric
             对每个下钻品类的候选机型写 fact/hypothesis/data_gap + 覆盖度 + 待验证问题，分批写到
             model_analysis_result.json 的 modelDrilldowns；本期数字只能来自 candidate_models，禁编造。
  ↓
tick(finalize): current_stage==analyze → 机器闸门校验（每下钻品类有非空 summary）→ 读 Loop1 已发布
             display → 增量 merge modelDrilldowns（不清空 Loop1 board/tiers/secondary/category 文本）
             → validate 携带 expected_base_revision 原子写 → drilldown 交接单 published。
```

```bash
"$PYTHON_BIN" scripts/aiwan_loop2_tick.py \
  --analysis-key "$ANALYSIS_KEY" \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE" \
  --base-revision "${BASE_REVISION:-1}"
```

- Loop2 未提供 `run_id` 时使用 `loop2-<week>-<data_end_date>-r<base_revision>`；`worker_id` 缺省 `loop2:<week>:<data_end_date>:b<base_revision>`，跨 tick 稳定。当前上线计划不调度该入口。
- 独立 Loop2 schedule 推荐 `daily 07:00 Asia/Shanghai`；正式创建/修改远端 Loop 前必须先 dry-run 并停在人审门禁。
- 机型 SQL 只提交一次，排队/运行中只 poll、不重提；终态失败最多重试 2 次。
- 核心机型快照缺失/占位时降级为 GMV Top-N + 异动机型兜底，并打 `warn: CORE_MODEL_SNAPSHOT_MISSING`（整体最多 partial_failed，补齐快照后自动补跑）。
- Loop2 analyze 前必须读取服务器 `model_history`、`previous_model_drilldowns`、`rules`、`loop2_context_meta`，最多重试 3 次；失败才降级为 `history_unavailable`，只允许本周周环比和核心机型状态，禁止连续趋势、历史归因、强机会/强风险。
- 多周趋势、Top1/Top3/Top5 集中度、首次/连续/反转/恢复由系统写入 `system_evidence`，agent 只能引用，不得自行计算；未结束周可展示周日均和环比，但不计入连续 3 周趋势。
- **上线前置**（见交接说明）：`load_model_rows_for_categories`（机型 CSV 解析）、读取 Loop1 已发布 display、机型 validate 服务器写三处集成 seam 需按真实服务器契约接线；未接线时 process/validate 会显式打 `MODEL_ROWS_PARSER_NOT_WIRED` / 返回 `retryable_failed`，绝不伪装发布。

## 快速预检

只检查入口、依赖、7 份 SQL、build marker 与输出目录，不执行 SQL、不调用 APIHub、不生成业务结果：

```bash
cd "${ZLOOP_ACTIVE_SKILL_DIR:-${CLAUDE_SKILLS_DIR:+$CLAUDE_SKILLS_DIR/b28e30d2-b8c6-456f-888d-57c48785286f}}"
PYTHON_BIN="$(command -v python3 || command -v python || true)"
test -n "$PYTHON_BIN" || { echo '{"ok":false,"error":{"code":"PYTHON_MISSING"}}'; exit 2; }
"$PYTHON_BIN" scripts/aiwan_inline_state_machine.py --preflight --json
```

预检目标耗时小于 3 秒。`ok=false` 时原样返回稳定错误码，不得继续完整运行。

## 全局硬约束

1. 禁止使用 `find`、`locate` 或递归 `ls` 搜索本 Skill。
2. 禁止探测 `/mnt/skill`、workspace、HOME 或 `/tmp` 来猜安装位置。
3. 禁止通过物理路径或 `versions/<version-id>` 判断 SkillVersion；版本选择由平台的 follow-current / pin-version 绑定负责。
4. Skill 内部路径一律相对已解析的入口目录（`ZLOOP_ACTIVE_SKILL_DIR`，缺失时 `CLAUDE_SKILLS_DIR/<preferred_skill_id>`）；脚本内部资源一律基于 `__file__` 解析。
5. 取数方式（必须触发）：用 Skill 工具加载 `xinghe-data-explore` 作为唯一底层取数能力，并遵循其已确认 SQL/异步执行契约；禁止自取数、直连 Hive/One-Service 或自行拼认证信息。Loop1 只允许 5 份基础 SQL（含 `sqldau`），full7 兼容入口为 7 份。
6. read/process 禁止读写 AIWAN 服务器；analyze 只读；validate 才能最终写入并复读。
7. process 使用 v30 的流式 Python pipeline，禁止回退到会在 4GB 沙箱 OOM 的全量 Node pipeline。
8. `analysis_result.display_contract` 必须为 `dashboard-business-overview-insights-map/v1`，且 `display_insights` 完整。
9. 只有 validate 返回 `server_write_confirmed=true` 且复读命中同一 `run_id`，业务才可成功。
10. 任一阶段失败立即停止，禁止让 Loop 平台 `succeeded` 掩盖业务失败。

## 成功与失败判定

- Loop1 待续：`business_status=pending`且退出 0，等待下一 tick 从服务器状态恢复。
- Loop1 成功：基础四阶段通过、dashboard 复读命中同版本、base job 为 `published`。handoff / Loop2 是非阻断预留能力，不参与当前上线成功判定。
- full7 成功：四阶段均有结果、`publish_allowed=true`、`server_write_confirmed=true`。
- 告警成功：满足成功条件，但 read/process/analyze 存在非阻断 warning。
- 失败：脚本退出码非 0、`ok=false`、阶段缺失、validate 未确认写入或复读不一致。

最终答复必须是短 JSON 摘要，优先复述脚本最终 JSON / `aiwan_inline_result.json` 的关键字段，不得重新组织成只含 READ 的摘要。禁止输出 `<think>`、推理过程、调试日志、长篇 Markdown 复盘或中间排障叙述；中间诊断只允许写入本地产物，不进入最终答复。发布终态优先复述 `final_summary.json` 字段，并只引用 `aiwan_loop1_diagnostics.json` 路径。失败时只返回错误码、失败阶段、可重试性、`artifacts_dir` 和必要诊断字段。

## 故障路由（仅命中错误时读取）

- SQL、物化、raw_cache 或数据周问题：读取 `references/read/query-playbook.md`。
- Loop1 jobs API、CAS、租约、SQL checkpoint 或发布复读问题：读取 `references/loop1-control-plane-contract.md`。handoff 仅用于预留能力排查，不作为当前上线阻断项。
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
  "entrypoint_resolution_mode": "active_skill_dir_then_claude_skills_root",
  "orchestrator_build": "v1.6.52-loop2-gate-driver-label",
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

最终答复长度建议控制在 2000 字符以内；若需要保留完整诊断，写入 `artifacts_dir` 下的诊断文件并在 JSON 中引用路径。
