---
name: 小万经营分析 v1.5.5
description: AI 小万 v1.5.5 四阶段流水线第 3 阶段：消费 Process 阶段的 analysis_history 与 model_tag_knowledge，先生成 evidence_pack，再按 daily/deep_dive 双模型策略产出 insights、summary、review_notes、analysis_trace。
version: 1.5.5
---

# 小万经营分析

## 所属流程与边界

本 Skill 是 AI 小万 v1.5.5 四阶段流水线第 3 阶段：

```text
Fetch 取数 → Process 数据处理/缓存 → Analyze 经营分析 → Validate 数据校验
```

本阶段只做 **证据抽取 + LLM 分析 + 复核记录**，不跑 SQL、不做数据处理、不发布 dashboard、不推飞书、不输出最终 pass/fail 裁决；最终裁决交给「小万经营校验」。

## 必读参考

执行前必须读取：

```text
references/evidence-contract.md
references/model-adaptation.md
references/insights-schema.json
```

## 输入要求

必须读取并校验：

```text
active_process_manifest.json
analysis_history_<run_dt>.json
model_tag_knowledge_<run_dt>.json
```

可选读取（用于证据回链，不可直接整体喂给 LLM）：

```text
server_cache_bundle_<run_dt>.zip
```

### 前置检查

必须满足：

```text
active_process_manifest.stage == process
active_process_manifest.status in [success, warn]
active_process_manifest.run_dt == 当前 run_dt
analysis_history 存在且 sha256 校验通过
model_tag_knowledge 存在且 sha256 校验通过；若缺失，只能 warn，并在 known_gaps / data_quality_notes 明确标记 core_model_coverage_unavailable
```

计算有效历史周数：

```text
effective_history_weeks = active_process_manifest.history_weeks_available
  ?? analysis_history.history_weeks_available
  ?? active_process_manifest.history_weeks
  ?? analysis_history.history_weeks
```

如果：

```text
effective_history_weeks < 8 或 active_process_manifest.analysis_scope_hint == wow_only
```

则：

```text
analysis_scope = wow_only
```

禁止输出 8-10 周趋势、长期趋势、连续多周变化等结论；只能输出目标周 vs 上周的观察与待确认假设。Analyze 输出中的 `history_weeks` 必须写 `effective_history_weeks`，不要把配置保留窗口 `history_weeks=10` 误当作真实可用周数。

## 默认参数

```json
{
  "analysis_mode": "daily",
  "compare_window": "target_week_vs_previous_week",
  "focus_levels": ["category", "model", "fulfillment"],
  "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"],
  "fallback_to_other_llm": false,
  "require_evidence_pack_first": true,
  "require_evidence_id": true,
  "risk_tolerance": "conservative",
  "publish_dashboard": false,
  "push_feishu": false
}
```

## LLM 白名单与职责

只允许：

```text
GLM-5.2
DeepSeek V4 Pro
```

禁止 fallback 到其他模型；若任一指定模型不可用，必须把当前阶段标记为 `failed` 或 `warn`，并写入 `analysis_trace.model_invocations[].error`，不得替换第三个模型。

### daily 模式

```text
analysis_history + model_tag_knowledge → evidence_pack → GLM-5.2 主生成 → DeepSeek V4 Pro 复核 → 确定性合并 → analysis_trace
```

- GLM-5.2：基于 `evidence_pack` 生成 `insights_<run_dt>.json` 和 `summary_<run_dt>.md`；
- DeepSeek V4 Pro：生成 `review_notes_<run_dt>.md`，只检查无证据结论、遗漏异常、known_gap 误用、过度归因、核心机型遗漏和置信度降级建议；
- 合并：只按 evidence 规则保留、降级或删除，不引入第三模型仲裁。

### deep_dive 模式

```text
evidence_pack + target_anomalies → DeepSeek V4 Pro 深挖 → GLM-5.2 结构化 → 确定性合并
```

触发条件：用户明确要求深挖、daily 发现 `severity=high` 且需要进一步归因、或 reviewer 指出高严重度遗漏。

- DeepSeek V4 Pro：对指定品类/机型/履约断点做深挖草稿；
- GLM-5.2：把草稿压缩成 schema 固定的 insights / deep_dive 摘要；
- 所有原因必须引用 evidence_id；无法确认的原因标为 `pending_business_confirmation` 且 `confidence=low|medium`。

## evidence_pack 生成要求

必须先生成：

```text
evidence_pack_<run_dt>.json
```

不允许把全量 Excel、全量 model 明细、server cache 全量对象直接交给 LLM。

证据包必须基于 `analysis_history_<run_dt>.json` 与 `model_tag_knowledge_<run_dt>.json` 生成，至少包含：

```text
category_top_changes
model_contributors
fulfillment_breakpoints
trend_features
data_quality_notes
known_gaps
core_model_coverage
```

每条证据必须有稳定 `evidence_id`，并写入 `evidence_index`，用于 Validate 阶段校验。

### 确定性抽取规则

1. **target_week / previous_week**：从 `analysis_history` 中最新 `week_start_date` 推导目标周，上一周为目标周前 7 天；不得用系统日期猜测。
2. **category_top_changes**：对 GMV、成交量、下单量、估价 UV、机况 UV 等核心指标计算 `current_value`、`previous_value`、`delta`、`wow_pct`，分别抽 Top 涨跌与绝对变化。
3. **model_contributors**：围绕高影响品类抽取贡献最大的机型 / 核心属性 / 成色 / 履约组合；用 `model_tag_knowledge` 补充 `is_core_model`、`core_rank`、`tag_ids`、`tag_names`、`knowledge_version`，计算 `contribution_pct`。
4. **fulfillment_breakpoints**：按下单量 → 发货量 → 签收量 → 质检量 → 成交量 → 退回量检查断点，例如“下单量上涨但成交量未上涨”“签收到质检掉点”“退回量异常上升”。
5. **trend_features**：仅当 `effective_history_weeks >= 8` 时生成 8-10 周趋势特征；否则该数组为空或仅写 `disabled_reason=history_insufficient` 的 DQ 证据。
6. **data_quality_notes**：显式记录 `board_metrics_feishu.csv` 缺口、previous_value 为 0、sheet/字段缺失、header_normalized 异常、上游质量门禁 warn/failed、model_tag_knowledge 缺失或过期。
7. **core_model_coverage**：按品类列出核心机型清单、已进入贡献证据的核心机型、因数据缺失未覆盖的核心机型；任何核心机型的高波动证据不得遗漏。

## LLM 输入约束

交给 LLM 的上下文只能包含：

```text
evidence_pack 的压缩字段
insights schema
模型职责 prompt
必要的用户 deep_dive 目标对象
```

不得包含：

```text
全量 Excel / raw CSV / 4.7 万行 model 明细 / 未压缩 server cache
```

## 输出要求

必须输出：

```text
evidence_pack_<run_dt>.json
insights_<run_dt>.json
summary_<run_dt>.md
review_notes_<run_dt>.md
analysis_trace_<run_dt>.json
active_analysis_manifest.json
```

### insights 要求

`insights_<run_dt>.json` 必须符合 `references/insights-schema.json`，并满足：

- 每条 `key_findings` / `risks` / `opportunities` 都有 `evidence_ids`；
- `evidence_ids` 均能在 evidence_pack 中找到；
- `model_trace.primary/reviewer/formatter` 只能是 GLM-5.2 或 DeepSeek V4 Pro；
- known_gap 只能作为缺口或待确认事项，不能写成确定性归因；
- 归因措辞保守：没有直接证据时只能写“可能相关 / 待运营确认”，不得写“导致 / 主因 / 直接造成”。

### summary 要求

`summary_<run_dt>.md` 必须面向业务方简洁表达，并在关键结论后标注证据 ID，例如：

```text
- 手机品类 GMV 环比下降，主要观察到 iPhone 核心机型贡献下滑 [CAT_GMV_DOWN_001, MODEL_CONTRIB_003]。
```

禁止写“已发布 dashboard”“已正式推送飞书”“最终校验通过”。

### review_notes 要求

`review_notes_<run_dt>.md` 必须记录 DeepSeek V4 Pro 复核结论，至少包含：

```text
- evidence 覆盖情况
- 无证据或弱证据结论
- known_gap 误用风险
- 过度归因风险
- 核心机型遗漏检查
- 建议降级/删除/补充的 insight
```

### analysis_trace 要求

`analysis_trace_<run_dt>.json` 至少包含：

```json
{
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "effective_history_weeks_source": "active_process_manifest.history_weeks_available",
  "inputs": { "process_manifest": "", "analysis_history": "", "model_tag_knowledge": "" },
  "evidence_pack": "evidence_pack_<run_dt>.json",
  "model_invocations": [
    { "role": "primary_writer", "model": "GLM-5.2", "prompt_hash": "", "output_hash": "", "status": "success|failed" },
    { "role": "reviewer", "model": "DeepSeek V4 Pro", "prompt_hash": "", "output_hash": "", "status": "success|failed" }
  ],
  "merge_decisions": [],
  "llm_policy": { "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"], "fallback_to_other_llm": false }
}
```

### active_analysis_manifest 最小字段

```json
{
  "stage": "analysis",
  "status": "success|failed|warn",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "upstream_stage": "process",
  "upstream_run_id": "",
  "analysis_mode": "daily|deep_dive",
  "analysis_scope": "trend_10w|wow_only",
  "history_weeks": 10,
  "evidence_pack": "",
  "insights": "",
  "summary": "",
  "review_notes": "",
  "analysis_trace": "",
  "known_gaps": [],
  "sha256": {},
  "llm_policy": {
    "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"],
    "fallback_to_other_llm": false
  }
}
```

## 冲突处理规则

| 情况 | 处理方式 |
| --- | --- |
| 两模型一致且有强 evidence | 保留，`confidence=high` |
| GLM-5.2 有结论，DeepSeek V4 Pro 认为证据不足 | 降级为观察项或删除，`confidence=low` |
| DeepSeek V4 Pro 发现遗漏异常且有 evidence_id | 补入 `key_findings` 或 `risks` |
| 归因冲突 | 并列为可能原因，`rule_status=pending_business_confirmation` |
| 涉及 known_gap / board_metrics_feishu.csv 缺口 | 不做确定性结论，只写缺口和待补齐 |
| 任一结论没有 evidence_id | 删除或转入 `data_quality_notes` |

## 成功判定

- 上游 process manifest 校验通过；
- evidence_pack 生成且 evidence_id 唯一；
- insights.json 符合 schema；
- summary.md 生成；
- review_notes.md 生成；
- analysis_trace 记录双模型调用和确定性合并；
- active_analysis_manifest 更新；
- 不声称最终通过，最终裁决交给「小万经营校验」。
