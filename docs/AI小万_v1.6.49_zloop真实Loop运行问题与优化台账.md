# AI小万 v1.6.49/v1.6.50 zloop 真实 Loop 运行问题与优化台账

审计时间：2026-07-21  
生产 Loop job：`98cd6ff0-007a-4796-b0fc-1addf37f1add`  
主编排 Skill：`AI小万主编排 v1.6` / `b28e30d2-b8c6-456f-888d-57c48785286f`  
当前包版本：`1.6.51`（`zloop-skills/ai-wan-v16-orchestrator.zip` 已同步到本地待发布包）  
业务线：`聚合回收 (business_id=5)`  
生产调度：daily `06:10 Asia/Shanghai`，`concurrency_policy=skip_if_running`

## 当前状态快照

- 2026-07-21 晚间已完成非平台侧修复包 `1.6.50 / v1.6.50-nonplatform-stability`，并叠加 `1.6.51 / v1.6.51-loop-prompt-hardening` 同步真实 Loop prompt hardening：
  - SQL `USER_CANCELED / USER_CANCELLED` 归一化为 `CANCELED`，Loop1/Loop2 均按失败终态进入重试/最终失败，不再永久 pending。
  - `analyze_input.json` 保持完整 evidence，不做压缩；新增非损耗导航产物 `analysis_digest.json`、`analysis_categories_index.json`、`analysis_top_movers.json`、`analysis_category_shards/*.json`、`category_tail_hints.json`。
  - 发布终态新增 `final_summary.json` 与 `aiwan_loop1_diagnostics.json`，最终回复只引用短摘要和诊断路径。
  - `SKILL.md`、`loop1-scheduled-prompt.md` 已明确禁止 `<think>`、长推理、完整 analyze 文案进入 final_text。
  - 本地验证：`python3 -m py_compile zloop-skills/ai-wan-v16-orchestrator/scripts/*.py` 通过；`python3 -m unittest discover -s zloop-skills/ai-wan-v16-orchestrator/test` 110 条通过；`zloop skill-forge package-check ... --mode update` 通过，10 个 warning 均为既有/非阻断项。
  - 已发布到线上主编排 Skill current：`1.6.50` candidate `cand_a53ed377311647fa8e9c1d280489bd43` / version_id `89f669e804dc48369ea9f27dcb7dbc58` / 线上 version `54`；`1.6.51` candidate `cand_caaa4ae4a14e4328a0c246aeacf63fa9` / version_id `ab1aadd18e81408196f713d7c193b4ed` / 线上 version `55` / official package sha256 `e9cc2165b1cca9296a2824119aab1f7438f2a3374d71cef55d5d77e24cde8238`。
  - 真实生产 Loop 验证：
    - `2fa093b5-3da0-4b8d-a8a5-573a3257a10e`：succeeded，`business_status=late_published`，输出已包含 `final_summary` / `diagnostics` 路径，但 final_text 仍有 `<think>` 前缀。
    - `ab985e82-d968-4782-9852-1803e80b8096`：生产 prompt 加顶层最终输出硬约束后再次 succeeded，业务 JSON 压缩为单行短 JSON，但 final_text 仍有 `<think>` 前缀。结论：内容侧已加约束与 summary 产物，persisted final_text 的思考标签剥离需要平台/模型输出层处理。
    - `309085c9-5c19-4bba-96dc-b1edd57c497a`：线上 current version `55` 后再次 succeeded，`business_status=late_published`，短 JSON 含 `final_summary` / `diagnostics`，仍有 `<think>` 前缀，确认该问题需平台侧处理。
- 生产 job prompt 已恢复为 `BASE_REVISION="${BASE_REVISION:-1}"`，没有停留在 r2 测试配置。
- 当前真实 r2 run 已终态成功，但依赖一次手工 checkpoint 修复：
  - `run_id=44066af8-ce0e-4405-aca9-db4b6d883970`
  - `session_public_id=5cf04703-2f37-469f-9cb2-d00ce9dcec18`
  - `status=succeeded`
  - `finished_at=2026-07-21T12:40:42.667786Z`
  - `business_status=late_published`
  - `job_status=published`
  - `stage_results=read:success / process:warn / analyze:warn / validate:success`
  - `category_daily_avg` 先卡在 `USER_CANCELED`，手工将 checkpoint status 改为 `CANCELED` 后触发重提，新的 `execute_id=754591565`
  - assistant final_text 约 33548 字符，包含 `<think>`，metadata 记录 `elapsed_ms=2316085`、`parts_count=123`、`tool-Bash=60`
  - events 仍只有 `created` / `started` / `succeeded`，缺少中间 sandbox、skill、tool、checkpoint 进度事件
  - `worker_deploy_id=production:6389-177-2`
  - `worker_instance_id=zai-workbench-backend-65bcb4dd5f-rx5h2`
- 最近可参考 run：
  - `6ce39efb-6b9b-4285-904f-e6b36ae136be`：成功，约 132 秒，命中已发布 r1 状态。
  - `39c1545e-db69-4417-900c-9ff4891192e1`：成功，约 1064 秒，完整链路中出现 409/CAS、gate 重试与大量推理文本。
  - `683758fb-cce8-4062-8e69-348499470476`：定时成功，约 2668 秒，完整链路耗时偏长，final_text 约 3 万字符。

## P0：会导致真实 Loop 卡死或无法自动恢复的问题

### 1. SQL 终态枚举未归一化，`USER_CANCELED` 会造成永久 pending

类型：内容侧 / 脚本稳定性  
影响范围：Loop1、Loop2、inline 兼容入口  
证据：

- `aiwan_inline_state_machine.py` 的 `TERMINAL_FAILED` 只有 `FAILED / FAIL / ERROR / CANCELLED / CANCELED / TIMEOUT`。
- `aiwan_loop1_tick.py` / `aiwan_loop2_tick.py` 直接使用 `str(status).upper()` 和 `FAILED_STATUSES` 判断。
- 星河实际可能返回 `USER_CANCELED`，不在失败集合中，于是既不是成功也不是失败，会被当作仍在运行，反复 `sql_not_ready`。

建议修复：

- 增加统一 `normalize_sql_status()`，所有 checkpoint status 与 `poll_sql()` 返回值先归一化。
- 至少把 `USER_CANCELED / USER_CANCELLED / CANCELLED` 归一到 `CANCELED`。
- `FAILED_STATUSES` 兜底包含原始别名，避免历史 checkpoint 已存旧值时仍卡住。
- 补单测：Loop1/Loop2/inline 对 `USER_CANCELED` 都进入 `SQL_TERMINAL_RETRY_SCHEDULED` 或最终 failed，而不是 pending。

状态：已在 `1.6.50` 修复并加回归测试。

### 2. Loop events 缺少执行中进度，排障只能翻长 messages

类型：平台侧 / runner 或 chat runtime  
影响范围：真实 zloop Loop 测试与生产调度  
证据：

- run `44066af8-ce0e-4405-aca9-db4b6d883970` 最终 succeeded，但 events 只有 `created / started / succeeded`。
- 中间实际发生了 Skill 激活、SQL 轮询、`USER_CANCELED` 卡住、手工 checkpoint 修复、SQL 重提、analyze 自检、duplicate ratio 修复、validate 发布，但这些关键过程没有结构化事件。
- 因此运行中会看起来像“started 后无进展”；排障只能读取 3 万字符级别 final_text。

建议给平台排查：

- scheduled-agent 应输出 sandbox 创建、skill activation、首个 tool 调用、最后活跃时间等阶段事件。
- 运行中需要 heartbeat 或 tool-progress 事件；否则 long-running 任务和 stuck 任务不可区分。
- events 需要记录 sandbox 创建、skill activation、首个 tool 调用、心跳和最后活跃时间。

### 2.1 persisted final_text 仍会拼入 `<think>` 前缀

类型：平台侧 / 模型输出隔离  
影响范围：Loop 最终消息可读性、下游自动解析  
证据：

- `1.6.50` 已在 `SKILL.md`、`loop1-scheduled-prompt.md` 与生产 job prompt 顶部加入“禁止 `<think>`、只输出原始 JSON”的硬约束。
- 第二次真实 run `ab985e82-d968-4782-9852-1803e80b8096` 的业务输出已压缩为短 JSON，但 persisted `final_text` 仍以 `<think>让我按照指令执行...` 开头。

结论：

- 内容侧已完成可做的约束：脚本产出 `final_summary.json` / `aiwan_loop1_diagnostics.json`，生产 prompt 要求只输出原始 JSON。
- 仍出现 `<think>` 属于平台/模型输出层未剥离思考标签；需要平台侧在 scheduled-agent persisted message 前过滤，或调整模型/SDK 的 reasoning 输出配置。

### 3. `skip_if_running` 遇到悬挂 run 会阻塞后续生产调度

类型：平台侧 + 流程策略  
影响范围：生产定时任务可用性  
证据：

- 生产 job 使用 `concurrency_policy=skip_if_running`。
- 如果某次 run 长时间 running 且无终态，下一次 scheduled run 可能被跳过。

建议修复：

- 平台侧增加 run heartbeat/watchdog，超过无事件阈值自动 timeout。
- 内容侧最终输出中携带 `last_business_status` / `last_checkpoint_stage`，便于判断是业务 pending 还是 runner 卡死。
- 发布流程中避免在生产 job 上触发长时间 r2 测试；优先使用可见但隔离的 trial job，或平台修复 draft/manual runner 后再恢复 trial 路径。

## P1：已跑通但影响稳定性、可观测性或后续维护的问题

### 4. final_text 持久化了 `<think>` 推理和大量过程文本

类型：平台侧 + prompt/content 兜底  
影响范围：用户可读性、消息体大小、隐私与稳定性  
证据：

- 多个成功 run 的 assistant final_text 包含 `<think>...</think>`。
- 代表 run final_text 长度：`2026 / 17883 / 29875 / 39336` 字符。
- metadata parts 中有 `reasoning`，final_text 仍混入推理内容。

建议修复：

- 平台侧：final_text 持久化前剥离 hidden reasoning / `<think>`。
- 内容侧：prompt 最后一段改为“最终只能输出一个短 JSON 摘要，不输出执行过程、推理、调试日志或 Markdown 长文”。
- 脚本侧：提供 `final_summary.json`，让 agent 只复述固定字段。

### 5. 完整链路耗时长，且 analyze 阶段容易反复读大文件和自我修正

类型：性能侧 / agent 编排  
影响范围：真实 Loop 耗时、成本、超时概率  
证据：

- 定时成功 run `683758...` 耗时约 44.5 分钟。
- 完整链路 run `39c154...` 耗时约 17.7 分钟。
- final_text 显示 agent 多次分段读取 `analyze_input.json`、rubric、schema，并修复 duplicate ratio / gate 文案。

建议修复：

- 不压缩完整证据，保留用户要求的全量 `analyze_input`；但增加非损失型索引：
  - `digest.json`
  - `categories_index.json`
  - `category_shards/category_001_030.json`
  - `top_movers.json`
- agent 先读 digest 与索引，再按需读取分片，减少无效全文扫描。
- 低价值尾部品类可由确定性差异化文案生成器预填，LLM 重点写 board、三层、重点二级类目、Top 风险/机会品类。
- gate 的重复率、受控标签、短历史禁词在写入前提供更明确的 scaffold 示例，减少先失败再修。

### 6. CAS/lease 续租和上游 409 的语义仍需要持续防回归

类型：内容侧 / 控制面稳定性  
影响范围：analyze/finalize 跨 tick、长分析后发布  
证据：

- 历史完整 run 中出现多次 409/CAS 诊断。
- v1.6.49 已补 `checkpoint_update_refreshing`、API Hub wrapped 409 识别、validate 失败不回滚，但需要覆盖真实服务返回形态。

建议修复：

- 保留并扩展单测：`HUB_UPSTREAM_ERROR + upstream_status=409`、HTTP 502 包装上游 409、lease expired 后 claim 续租、validating/validate 复跑。
- 运行产物中记录每次 jobs/write 的 `action/status/state_revision_before/after/error_code`，形成轻量 control-plane trace。

### 7. Loop 外显 artifacts 不足以排障

类型：平台侧 + 内容侧  
影响范围：线上排障效率  
证据：

- loop artifacts 当前主要展示 SQL 文件和 94B summary。
- 关键诊断产物在远端沙箱路径内：`analyze_input.json`、`analysis_result.json`、`analysis_result_autofix.json`、`analysis_result_assembled.json`、process manifest、quality report、control-plane trace。

建议修复：

- 内容侧生成 `aiwan_loop1_diagnostics.zip`，包含：
  - `final_summary.json`
  - `run_manifest.json`
  - `control_plane_trace.jsonl`
  - `sql_checkpoints.json`
  - `quality_report.json`
  - `gate_report.json`
  - `analysis_result_assembled.json`
- 平台侧支持把指定 diagnostics 文件作为 Loop artifact 上传或展示。

状态：内容侧已在 `1.6.50` 先落 `final_summary.json` 与 `aiwan_loop1_diagnostics.json`；是否展示为 Loop artifact 仍属平台侧能力。

### 8. pending 行为在 prompt 中有歧义：同一 run 内等待，还是让下一 tick 继续

类型：流程设计 / 性能稳定性  
影响范围：长运行、调度成本、超时风险  
证据：

- 生产 prompt 写：`business_status=pending` 时等待约 30 秒后重复同一命令。
- Skill 文档又写：pending + exit 0 表示 tick 正常结束，同一调度计划也应以 10 分钟节奏重复触发。

建议修复：

- 明确定义 Loop1 是“短 tick”还是“单 run 内轮询直到完成”。
- 如果采用短 tick：pending 后 agent 立即输出结构化 pending，结束本 run，由下一次调度接力。
- 如果采用单 run 内轮询：脚本自己做有上限的 poll/backoff，不让 LLM 控制 sleep/retry。
- 推荐：SQL read 阶段短 tick；analyze/finalize 阶段单 run 内完成，避免 agent 长时间空等 SQL。

### 9. 模型 pin 只能记录，不能由 Loop 服务端可靠强制

类型：平台侧能力缺口  
影响范围：验收可信度  
证据：

- prompt 和 SKILL.md 都声明 Loop 服务端当前不能可靠强制模型。
- 脚本只能在 Runtime 暴露 model id 时校验；否则标记 `unverified_no_runtime_model_env`。

建议修复：

- 平台侧给 Loop job 提供可持久化、可强制的 model 配置。
- runtime env 必须暴露实际 model id。
- 产物中保留 `required_model_id / runtime_model_id / verified / verification`。

## P2：流程清晰度和后续性能优化项

### 10. 平台占位回复与 prompt 约束冲突

类型：平台侧 / UX  
影响范围：误判任务是否执行  
证据：

- prompt 明确禁止回复“已提交、排队、稍后通知”。
- 当前 r2 run assistant 占位消息仍是“已提交，正在排队执行”，并处于 `stream_status=streaming`。

建议修复：

- 平台占位消息不应作为模型最终回复持久化，或需要标记为 `system_placeholder=true`。
- 当进入真正 skill 执行时追加明确事件；没有进入时应 timeout。

### 11. Trial draft/manual runner 与生产 runner 表现不一致

类型：平台侧 / 发布流程  
影响范围：安全试跑  
证据：

- hidden draft full-chain r2 测试曾长时间只有 placeholder，后被取消。
- 生产 job 触发的 r1 成功，说明 draft 路径可能有独立 runner/stream 问题。

建议修复：

- 平台修复 draft job manual run 与 enabled job manual run 的执行一致性。
- 发布流程恢复“hidden draft → trial run → publish”的安全路径，减少动生产 job prompt 的必要性。

### 12. 并发策略需要从“是否上线”改成“SQL 执行资源调度”表达

类型：文档/认知稳定性  
影响范围：误解和上线风险判断  
证据：

- 用户曾误以为“并发上线”是 SQL 提交上线功能。
- 当前 SKILL.md 已解释 `MAX_ACTIVE_SQL=2` 是 SQL tick 执行策略，不是并发发布。

建议修复：

- 文档和 prompt 中统一改成“最多 2 条 SQL 同时排队/轮询”，避免“并发上线”措辞。
- 跑通后再基于真实耗时决定是否从 2 调成 1 或做自适应。

### 13. 版本发布验收需要固定检查 zip、manifest、远端 committed version

类型：发布流程  
影响范围：本地/远端内容不一致  
证据：

- 之前发现仓库 zip 曾是旧 `1.6.24`；当前已同步到 `1.6.50`。

建议修复：

- 发布前后固定检查：
  - 本地目录 `SKILL.md version`
  - 本地 zip `SKILL.md version`
  - `skill.manifest.json.orchestrator_build`
  - `package sha256`
  - skill-forge candidate/commit version_id
  - 真实 Loop metadata referenced skill public_id

### 14. Loop2/handoff 文案和生产闭环边界需要更干净

类型：流程边界  
影响范围：验收口径  
证据：

- v1.6.49 说明当前上线闭环只包含 Loop1，Loop2 drilldown 为预留能力。
- 部分历史 run 输出仍出现 `model_enrichment_mode=enabled`、handoff ready 等表述，容易让验收范围变大。

建议修复：

- 最终摘要中把 handoff 标为 `reserved_not_release_gate`。
- 生产闭环验收只认 Loop1 `published/late_published` + server write confirmed。
- Loop2 单独版本、单独 trial、单独验收。

## 建议执行顺序

### 流程跑通前必须先做

1. SQL 状态归一化：修 `USER_CANCELED` 死循环。
2. 当前 stuck run 的平台侧定位：started 后为什么无 sandbox/tool/skill 事件。
3. 避免悬挂 run 阻塞生产调度：确认 timeout/watchdog 或人工处理策略。

### 跑通后第一轮稳定性版本

1. final_text 输出清洗：禁止 `<think>` 和长过程文本。
2. diagnostics artifact：让排障不用翻长消息。
3. pending 策略收敛：短 tick / 单 run 内轮询二选一。
4. 409/CAS 回归用例扩展。

### 跑通后第一轮性能版本

1. 非损失型 analyze evidence 分片与索引。
2. deterministic tail category writer，LLM 聚焦关键层级和重点品类。
3. SQL poll/backoff 与 MAX_ACTIVE_SQL 基于真实耗时调参。
4. materialize/download 重试与耗时 trace。

## 当前不建议做的优化

- 不建议压缩或裁剪 `analyze_input` 的证据内容；会影响分析质量和可追溯性。
- 不建议把手动 API Hub 改 checkpoint 作为常规恢复方式；应作为一次性救火，永久修复靠状态归一化。
- 不建议在平台 runner 未修好前频繁用生产 job 改 prompt 做 r2/r3 full-chain；容易被 stuck run 和 `skip_if_running` 反噬。
