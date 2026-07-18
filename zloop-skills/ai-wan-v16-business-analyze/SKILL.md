---
name: AI小万经营分析 v1.6
version: 1.7.1
api_dependencies:
  - f3f2a89f-3c54-4f3d-92a0-04d2a25a6b8d
description: AI 小万 v1.6/v1.7 analyze 阶段 Skill：由本沙箱 agent（Claude Sonnet）按 v1.5.5 旧服务器分析效果亲自撰写分析，只读 AIWAN 服务器上下文，把 processed_data 确定性压成 evidence_pack，再按 analyze-parity-rubric.md + golden-fewshot.md 分批产出 insights/summary/analysis_trace/findings 与旧 dashboard 可直接消费的 display_insights；数字全部来自 evidence_pack，禁止编造。
---

# AI小万经营分析 v1.6

## 职责边界

本 Skill 只负责 AI 小万 v1.6 四阶段流水线第 3 阶段 `analyze`：

```text
read SQL 取数 → process 模板处理 → analyze 经营分析 → validate 校验并最终写服务器
```

本阶段必须保持新版阶段契约：

```text
接收 processed_data → 只读 AIWAN server_context → 生成 evidence_pack → 生成 findings + display_insights → 返回给主编排
```

必须做：

- 校验 `processed_data` 是 process 阶段输出，状态为 `success|warn`。
- 通过 APIHub read 读取服务器上下文（历史窗口、规则、已有配置、上一阶段产物摘要等）。
- 先把 `processed_data + server_context` 确定性压缩为 `evidence_pack`（数字只来自这里）。
- 再由**本沙箱 agent（Claude Sonnet）亲自撰写分析**：读 `evidence_pack + analyze-parity-rubric.md + golden-fewshot.md`，**分批**产出 board/tiers/categories，合并成 `display_insights`。禁止用确定性 f-string 模板顶替真实分析，也禁止只回模板文案。
- 输出结构化 `analysis_result`，其中 `findings` 用于追溯，`display_insights` 是旧 dashboard bridge 的主消费结构。
- **必须补齐 v1.5.5 旧服务器分析效果产物**：`insights`、`summary`、`review_notes`、`analysis_trace`、`model_trace`、`llm_policy`；不得只返回 display 文案。
- evidence_id 必须使用 v1.5.5 大写前缀规范：`CAT_`、`CLUSTER_`、`MODEL_`、`FULFILL_`、`TREND_`、`DQ_`、`GAP_`、`CORE_`，并能在 `evidence_pack.evidence_index` 回链。

禁止做：

- 禁止重新跑 SQL、触发 xinghe、调用 One-Service 或读取数据库。
- 禁止改写 process 模板结果；只能基于其生成证据和分析。
- 禁止写入 AIWAN 服务器；最终写入只允许由 `AI小万结果校验 v1.6` 执行。
- 禁止直接给调价、补贴、投放等强策略动作；只能给下钻方向、风险确认、待确认假设和证据链。
- 禁止把全量 raw CSV、全量 Excel、未压缩 server cache 或海量明细直接读入上下文；只基于 evidence_pack 分析。
- 禁止一次性产出全部品类（会超输出上限被截断）；品类必须分批。
- 禁止编造 evidence_pack 中不存在的数字。

## Runtime Client Gate

- route decision：`update-owned`。
- runtime client：`hub`。
- 本阶段只允许调用 `zloop_runtime.hub` 的相对路径 read：`/v2/aiwan/api/aiwan/read`。
- 禁止 `/gw/`、完整网关域名、Authorization、APIHub token、自定义上游凭证头。
- 包内 `scripts/aiwan_apihub.py` 只能作为只读辅助脚本使用，不得新增 write 子命令。

## 模块路由（命中后必须读取）

执行本 Skill 时必须按需读取以下 reference；未命中的模块不要预读全量材料：

- **任何 analyze 运行**：必须读取 `references/apihub-read-write-contract.md`、`references/api-playbook.md`、`references/evidence-contract.md`、`references/display-insights-contract.md` 和 `references/insights-schema.json`。
- **任何 analyze 运行**：还必须读取 `references/five-layer-analysis-method.md`，并严格按飞书方法论 5 个业务 Skill 链执行：大盘链路定性 → 品类簇/分层判断 → 二级类目/品类下钻 → 机型归因 → 综合判断。
- **任何 analyze 运行**：还必须读取 `references/analyze-parity-rubric.md`（对齐 GPT-5.5 金标的可核对纪律与受控词表）和 `references/golden-fewshot.md`（少量金标范例作锚点）。每个批次都带 rubric，few-shot 只带少量范例，禁止把整周金标塞进上下文。
- **processed_data 或 server_context 含机型标签、核心机型、标签知识、规则快照**：还必须读取 `references/model-tag-knowledge-contract.md`。
- **deep_dive 模式或用户指定异常对象深挖**：只分析指定异常对象，深挖仍受 `analyze-parity-rubric.md` 纪律约束，所有原因引用 evidence_id。

读取 reference 前必须先遵守本文件的全局边界：不跑 SQL、不写服务器、不虚构证据、不输出无 evidence_id 的确定性结论。

## 输入要求

主编排必须传入完整 `processed_data`：

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "stage": "analyze",
  "analysis_mode": "daily",
  "processed_data": {
    "stage": "process",
    "status": "success|warn",
    "output_type": "processed_data",
    "run_id": "<same-run-id>",
    "week": "2026-W29",
    "metric_snapshot": {},
    "candidate_anomalies": [],
    "process_summary": {},
    "warnings": []
  },
  "scope": {"type": "weekly", "category": null}
}
```

### 前置校验

必须满足：

```text
processed_data.output_type == processed_data
processed_data.stage == process
processed_data.status in [success, warn]
processed_data.run_id == 输入 run_id
processed_data.metric_snapshot 存在
processed_data.candidate_anomalies 存在且为数组
```

如果 `processed_data.status=warn`，允许继续，但必须把 process warning 原样纳入 `evidence_pack.data_quality_notes` 与 `analysis_result.warnings`。

## 服务器上下文读取

本阶段是 v1.6 四阶段中唯一允许读取服务器上下文的分析阶段。

1. 读取 `references/apihub-read-write-contract.md` 与 `references/api-playbook.md`。
2. 通过包内脚本或等价的 `zloop_runtime.hub.post` 调用 read，只请求白名单字段：

```bash
python scripts/aiwan_apihub.py read \
  --run-id "$RUN_ID" \
  --stage analyze \
  --week "$WEEK" \
  --history-weeks 10 \
  --include run_meta,history_10w,rules,previous_stage_outputs,dashboard_snapshot
```

3. APIHub read 失败时：
   - 若 `processed_data` 足以生成周环比 evidence，允许 `status=warn` 降级继续；
   - 必须写入 `GAP_SERVER_CONTEXT_UNAVAILABLE_*` / `DQ_SERVER_CONTEXT_UNAVAILABLE_*`；
   - 不得伪造服务器历史、规则或标签。

## 有效历史周数与分析范围

计算：

```text
effective_history_weeks = processed_data.history_weeks_available
  ?? processed_data.process_summary.history_weeks_available
  ?? server_context.history_10w.available_weeks
  ?? server_context.run_meta.history_weeks_available
  ?? processed_data.history_weeks
  ?? server_context.history_10w.configured_weeks
```

如果：

```text
effective_history_weeks < 8 或 processed_data.analysis_scope_hint == wow_only 或 server_context.rules.analysis_scope_hint == wow_only
```

则：

```text
analysis_scope = wow_only
```

此时禁止输出 8-10 周趋势、长期趋势、连续多周变化等结论；只能输出目标周 vs 上周的观察与待确认假设。`analysis_result.history_weeks` 必须写 `effective_history_weeks`，不得把配置保留窗口误当作真实可用周数。

## 五层分步分析法

Analyze 阶段必须执行 `references/five-layer-analysis-method.md` 中定义的 5 层流程：

```text
1. 大盘链路定性 + 风险等级
2. 品类簇/分层归因 + 策略验证
3. 二级类目/品类下钻 + 影响度 + 停止条件
4. 机型归因 + 规律复用
5. 综合判断 + dashboard 页面展示
```

五层是顺序门禁，不是写作结构。第 1 层未通过不得生成确定性大盘结论；第 2 层必须稳定生成 `display_insights.tiers.发展/孵化/种子`；第 3 层只能使用真实 dashboard/category key；第 4 层机型/标签结论必须回写到对应品类或 findings；第 5 层必须生成旧 dashboard 可直接消费的 `display_insights`。

## 业务口径与页面 source of truth

`business_scope` / `data_scope` 必须来自 `processed_data` 或 APIHub read 返回的 `server_context`，优先级：

```text
processed_data.business_scope/data_scope
processed_data.active_process_manifest
server_context.run_meta/rules/dashboard_snapshot
dashboard 当前 week 的 metric_snapshot/candidate_anomalies/history_10w
```

禁止自行写“上门回收”“全渠道”“聚合回收”等未证明口径词。如果口径不确定：

- `analysis_result.business_scope.status = "uncertain"` 或等价字段；
- 写入 `analysis_result.warnings`、`analysis_result.display_insights.warnings`；
- 展示文案降级为“当前口径待确认/维持观察”，不得写成确定结论。

## evidence_pack 生成要求

必须先生成内嵌在 `analysis_result.evidence_pack` 的证据包；不允许跳过 evidence 直接让 LLM 写分析。

证据包必须基于 `processed_data` 与 APIHub read 返回的 `server_context` 生成，至少包含：

```text
category_top_changes
cluster_top_changes
model_contributors
fulfillment_breakpoints
trend_features
data_quality_notes
known_gaps
core_model_coverage
evidence_index
```

每条证据必须有稳定 `evidence_id`，并写入 `evidence_index`，供 validate 阶段校验。详细字段与抽取规则见 `references/evidence-contract.md`。

### 确定性抽取规则摘要

1. **target_week / previous_week**：优先从 `processed_data.week`、`metric_snapshot` 或 `server_context.history_10w` 推导，不得用系统日期猜测。
2. **category / cluster top changes**：对 GMV、成交量、下单量、估价 UV、机况 UV 等核心指标抽取 Top 涨跌与绝对变化。
3. **model_contributors**：围绕高影响品类抽取贡献最大的机型 / 核心属性 / 成色 / 履约组合；若有标签知识，用 `model_tag_knowledge` 增强，不得让 LLM 自行打标签。
4. **fulfillment_breakpoints**：按下单量 → 发货量 → 签收量 → 质检量 → 成交量 → 退回量检查断点。
5. **trend_features**：仅当 `effective_history_weeks >= 8` 时生成；否则生成历史不足 DQ/GAP 证据。
6. **data_quality_notes**：显式记录 process warning、服务器上下文缺口、previous_value 为 0、字段缺失、模型标签缺失或过期等。
7. **core_model_coverage**：任何核心机型高波动证据不得遗漏；覆盖不足只能降级表达。

## 分析执行：本沙箱 agent（Claude Sonnet）分批产出

analyze 由**当前运行本 Skill 的沙箱 agent（Claude Sonnet 4.6）亲自撰写**，不外挂 LLM 网关（当前系统不支持），也不从沙箱内 spawn 远端 chat 子 agent。数字全部来自 `evidence_pack`。

### 强制分批（避免超输出上限被截断）

实测：一次产出约 20 个品类 ≈ 2 万 output tokens；全量 100+ 品类会超单次输出上限被截断、且延迟过长。因此**必须分批**：

```text
批次 0：board + tiers(发展/孵化/种子) + category(全局概览) + monitor    —— 一次
批次 1..N：categories 按分层或每 20–30 个一批，多次产出            —— 每批带 rubric
合并：把各批 categories 合进同一份 display_insights.categories
```

- 每批都读 `analyze-parity-rubric.md`，few-shot 只带 `golden-fewshot.md` 的少量范例。
- 每批只处理本批品类，短列表判断更稳；禁止为了"一次写完"而牺牲纪律。

### 撰写纪律（对齐 GPT-5.5 金标）

严格执行 `analyze-parity-rubric.md`：

- 每句定性判断后紧跟客观数字；禁"效果显著/明显/大幅"等主观词。
- 量价判断只从 `量价同降/量跌价升/量降价升/量价同升` 选。
- 链路固定 `机况UV→估价UV→估价完成率→下单率→发货率→成交率`。
- 每个风险项落"先查X→再查Y + 预期验证假设"。
- 品类定性标签只从受控词表选：`高影响风险品类/明确机会品类/异常风险品类/低基数波动品类/稳健品类`。
- 每条结论引用 evidence_id；无直接证据只写"可能相关/待运营确认"，不写"导致/主因"。

### 自检（单 agent 内完成 reviewer 职责）

产出后自查一遍，等价于旧 reviewer：无证据结论删除或降级、遗漏异常补入、known_gap 不写成确定性归因、核心机型不遗漏。可核对项（schema 齐、每句带数、受控词、品类覆盖度）优先用确定性规则自检。

### deep_dive 模式

触发：用户要求深挖、daily 发现 `severity=high` 需进一步归因。只对指定异常对象深挖，所有原因引用 evidence_id；无法确认的标 `pending_business_confirmation` 且 `confidence=low|medium`。

## analysis_result 输出要求

必须输出：

```json
{
  "stage": "analyze",
  "status": "success|warn|failed",
  "output_type": "analysis_result",
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "server_context_used": true,
  "evidence_pack": {},
  "insights": {},
  "summary": {
    "headline": "",
    "bullets": []
  },
  "display_contract": "dashboard-business-overview-insights-map/v1",
  "display_insights": {
    "board": "",
    "tiers": {
      "发展": "",
      "孵化": "",
      "种子": ""
    },
    "secondaryCategories": {},
    "categories": {},
    "category": "",
    "monitor": "",
    "warnings": []
  },
  "findings": [],
  "review_notes": [],
  "analysis_trace": {},
  "known_gaps": [],
  "warnings": [],
  "next_stage": "validate"
}
```

失败时返回 `status=failed` 和 `error`，不要写服务器。

### findings 要求

`findings` 是给 validate 阶段追溯、校验和排查的扁平列表，必须由 `insights.key_findings / risks / opportunities` 确定性映射而来。旧 dashboard 页面不直接渲染 findings；页面主产物是 `display_insights`。每条 finding 必须包含：

```json
{
  "level": "overall|cluster|category|model|fulfillment",
  "entity_type": "overall|cluster|category|model|fulfillment",
  "entity_name": "内存条",
  "metric": "gmv",
  "direction": "up|down|flat|mixed|unknown",
  "severity": "high|medium|low|watch",
  "confidence": "high|medium|low",
  "evidence_ids": ["CAT_GMV_DOWN_001"],
  "evidence": [],
  "likely_causes": [],
  "recommended_drilldowns": [],
  "data_warnings": [],
  "rule_status": "confirmed|pending_business_confirmation"
}
```

硬约束：

- 每条 finding / key_findings / risks / opportunities 都必须有 `evidence_ids`。
- `evidence_ids` 均必须能在 `evidence_pack.evidence_index` 找到。
- known_gap 只能作为缺口或待确认事项，不能写成确定性归因。
- 归因措辞保守：没有直接证据时只能写“可能相关 / 待运营确认”，不得写“导致 / 主因 / 直接造成”。
- `effective_history_weeks < 8` 时，禁止任何趋势型 finding；只能写周环比观察。

### display_insights 要求

必须按 `references/display-insights-contract.md` 输出旧 dashboard 可直接消费的展示 map：

```json
{
  "display_contract": "dashboard-business-overview-insights-map/v1",
  "display_insights": {
    "board": "大盘洞察短段落",
    "tiers": {
      "发展": "发展层洞察短段落",
      "孵化": "孵化层洞察短段落",
      "种子": "种子层洞察短段落"
    },
    "secondaryCategories": {
      "<二级类目名>": "二级类目洞察短段落"
    },
    "categories": {
      "<三级品类名>": "品类洞察短段落，必要时包含机型/标签/分层内容"
    },
    "category": "全局品类概览短段落",
    "monitor": "监测说明短段落",
    "warnings": []
  }
}
```

硬约束：

- `display_insights` 是服务器 bridge 发布到 `business-overview-insights-<week>.json` 的主结构，丰富度必须对齐旧线上 dashboard。
- `board/category/monitor` 必须是非空 string。
- `tiers` 必须完整包含 `发展`、`孵化`、`种子`，由本 Skill 直接产出，不能依赖服务器兜底。
- `secondaryCategories` 必须覆盖 dashboard snapshot 中本周有有效数据的二级类目或 board。
- `categories` 必须覆盖 dashboard snapshot 或品类映射表中本周有有效数据的三级品类。
- 正常对象也必须生成指标型短评；异常对象写更完整归因和观察方向。
- key 只能来自真实 dashboard/category snapshot 或品类映射表；禁止 fuzzy match。
- 未匹配 finding 只能进入 `board`、`monitor`、`warnings` 或保留在 `findings`，不得塞入页面层级 map。
- 机型/标签/分层相关展示内容优先写入对应 `categories[品类名]` 文案。
- 文案使用短段落，不用 markdown bullet，不用表格。
- 指标使用中文名：机况UV、估价UV、下单UV、发货数、成交订单、成交GMV、下单率、发货率、成交率。
- 百分点写“0.80个百分点”，不得写 `pct`、`pp`。
- 禁止展示文案泄漏 `orderRate`、`shipCnt`、`dealGmv`、`wow_pct`、`entity_type` 等技术字段。
- 不直接给调价、补贴、投放等强策略动作，只给下钻方向、风险确认、观察建议。

### summary 要求

`summary` 必须面向业务方简洁表达，并在关键结论后标注证据 ID，例如：

```text
手机品类 GMV 环比下降，主要观察到 iPhone 核心机型贡献下滑 [CAT_GMV_DOWN_001, MODEL_CONTRIB_003]。
```

禁止写“已发布 dashboard”“已正式推送飞书”“最终校验通过”。

### review_notes 要求

`review_notes` 必须记录 agent 自检结论（等价旧 reviewer），至少包含：

```text
- evidence 覆盖情况
- 无证据或弱证据结论
- known_gap 误用风险
- 过度归因风险
- 核心机型遗漏检查
- 建议降级/删除/补充的 insight
```

### analysis_trace 要求

`analysis_trace` 至少包含：

```json
{
  "run_id": "",
  "week": "YYYY-Www",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "inputs": {
    "processed_data_digest": "",
    "server_context_digest": ""
  },
  "evidence_pack_digest": "",
  "model_invocations": [
    {"role": "writer", "model": "claude-sonnet-4-6", "batches": 0, "status": "success|failed"},
    {"role": "self_review", "model": "claude-sonnet-4-6", "status": "success|failed"}
  ],
  "self_review_decisions": [],
  "llm_policy": {"executor": "sandbox_agent", "model": "claude-sonnet-4-6", "batched": true}
}
```

## 冲突处理规则

| 情况 | 处理方式 |
| --- | --- |
| 结论有强 evidence | 保留，`confidence=high` |
| 自检认为证据不足 | 降级为观察项或删除，`confidence=low` |
| 自检发现遗漏异常且有 evidence_id | 补入 `key_findings` / `risks` / `findings` |
| 归因冲突 | 并列为可能原因，`rule_status=pending_business_confirmation` |
| 涉及 known_gap 或服务器上下文缺口 | 不做确定性结论，只写缺口和待补齐 |
| 任一结论没有 evidence_id | 删除或转入 `data_quality_notes` |

## 成功判定

- `processed_data` 校验通过。
- APIHub read 已执行；若失败已显式降级并记录 gap。
- `evidence_pack` 生成且 evidence_id 唯一。
- `insights` 符合 `references/insights-schema.json`。
- `findings` 非空或有明确数据不足原因。
- `display_contract` 与 `display_insights` 已生成，且 board、三层、二级类目、品类、category、monitor 可供旧 dashboard 直接消费。
- `summary`、`review_notes`、`analysis_trace` 已生成。
- 未写服务器，未声称最终通过；最终裁决交给 `AI小万结果校验 v1.6`。
