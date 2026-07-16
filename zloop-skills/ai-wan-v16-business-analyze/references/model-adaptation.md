# GLM-5.2 / DeepSeek V4 Pro 适配策略（AI 小万 v1.6 analyze）

## 可用模型

只允许：

```text
GLM-5.2
DeepSeek V4 Pro
```

禁止 fallback 到其他模型。任一模型不可用时，当前阶段必须 `warn|failed`，并在 `analysis_trace.model_invocations[].error` 记录，不得替换模型。

## daily 模式

```text
processed_data + server_context → evidence_pack → GLM-5.2 生成 → DeepSeek V4 Pro 复核 → 确定性合并 → analysis_result
```

| 角色 | 模型 | 输出 | 约束 |
| --- | --- | --- | --- |
| primary_writer | GLM-5.2 | `insights`、`findings`、`summary`、`display_insights` 草稿 | 只基于 evidence_pack；每条结论引用 evidence_id；页面文案遵守 display 契约 |
| reviewer | DeepSeek V4 Pro | `review_notes` | 不重写全文，只查错、查漏、降级建议，并检查页面文案合法性 |
| merge_rule | deterministic | `analysis_trace.merge_decisions` | 不引入第三模型 |

### GLM-5.2 主生成 Prompt 要点

```text
你是经营分析助手。只基于输入 evidence_pack 生成结论。
每条 key_findings / risks / opportunities / findings 必须引用 evidence_id。
不要补充未提供的数据，不要使用常识推断机型标签。
known_gaps 只能写成缺口或待确认事项，不能写成确定性原因。
`effective_history_weeks < 8` 或 `analysis_scope=wow_only` 时，禁止 8-10 周趋势结论。
必须输出符合 insights-schema.json 的 insights，并给出引用 evidence_id 的 summary、findings 和 dashboard-business-overview-insights-map/v1 display_insights。
display_insights 必须包含 board、tiers.发展/孵化/种子、secondaryCategories、categories、category、monitor、warnings。
secondaryCategories/categories 的 key 只能来自 dashboard/category snapshot 或品类映射表；正常对象也要生成指标型短评，异常对象写更完整归因。
展示文案使用短段落，不用 markdown bullet/table；指标用中文名；百分点写“0.80个百分点”；不得出现 pct/pp/orderRate/shipCnt/dealGmv/wow_pct/entity_type。
```

GLM 输出的 `findings` 必须是可由 `insights.key_findings / risks / opportunities` 回推的扁平列表，不得新增 insights 中不存在的事实。

### DeepSeek V4 Pro 复核 Prompt 要点

```text
你是经营分析质检员。不要重写全文。
只检查：
1. 无 evidence_id 或 evidence_id 不存在的结论；
2. 高严重度证据是否遗漏；
3. 核心机型高波动是否遗漏；
4. known_gap 是否被误用为确定性结论；
5. 是否出现过度归因（主因/导致/确定因果但证据不足）；
6. effective_history_weeks 不足时是否出现趋势结论；
7. 是否把服务器上下文缺口写成了确定性解释；
8. 哪些结论应降级 confidence 或改为 pending_business_confirmation。
9. display_insights 是否缺 board/category/monitor 或发展/孵化/种子；
10. secondaryCategories/categories 是否存在非法 key 或 fuzzy match；
11. 展示文案是否出现未证明口径词、技术字段、强策略动作、空泛兜底。
输出 review_notes，不直接改写最终 insights。
```

## deep_dive 模式

```text
evidence_pack + target_anomalies → DeepSeek V4 Pro 深挖 → GLM-5.2 结构化 → 确定性合并
```

| 角色 | 模型 | 输出 | 约束 |
| --- | --- | --- | --- |
| primary_analyst | DeepSeek V4 Pro | 深挖草稿 | 只分析指定异常对象；所有原因引用 evidence_id |
| formatter | GLM-5.2 | 结构化 `insights/findings/deep_dive_summary/display_insights` | 压缩为 schema；不得新增事实 |
| merge_rule | deterministic | `merge_decisions` | 无证据不保留 |

### DeepSeek V4 Pro 深挖 Prompt 要点

```text
你是经营分析专家。只分析指定异常对象。
基于 evidence_pack 构造可能归因链条，所有原因必须引用 evidence_id。
无法确认的内容标注 pending_business_confirmation。
涉及服务器上下文缺失、核心机型知识缺失、历史不足等 known_gap 时，不做确定性结论。
```

### GLM-5.2 结构化 Prompt 要点

```text
你是结构化编辑器。只把 DeepSeek 草稿中有 evidence_id 的内容转成 insights-schema.json、v1.6 findings 和 display_insights。
不得新增新事实、不得改变 evidence_id、不得把 pending 事项改成 confirmed。
display_insights 的页面文案必须来自同一批 evidence，不得用 findings 粗略拼接。
```

## 确定性合并规则

| 场景 | 处理 |
| --- | --- |
| 两模型一致且有证据 | 保留；`confidence=high` |
| reviewer 指出证据不足 | 降级 `confidence=low`，必要时改 `rule_status=pending_business_confirmation` |
| reviewer 发现遗漏且 evidence_id 存在 | 补充到 `key_findings` / `risks` / `findings`；记录 merge_decision |
| 归因冲突 | 并列可能原因，待运营确认 |
| 涉及 known_gap | 不做确定性结论 |
| 缺 evidence_id | 删除或转入 `data_quality_notes` |
| finding 与 insights 不一致 | 以 insights 中可回链证据为准重新映射 finding |

## analysis_trace 最小记录

每次模型调用必须记录：

```json
{
  "role": "primary_writer|reviewer|primary_analyst|formatter",
  "model": "GLM-5.2|DeepSeek V4 Pro",
  "prompt_hash": "",
  "input_evidence_pack_hash": "",
  "output_hash": "",
  "status": "success|failed",
  "error": null
}
```

合并阶段必须记录被删除、降级、补充的结论及原因，保证 validate 和人工复查能知道最终结论如何形成。
