# GLM-5.2 / DeepSeek V4 Pro 适配策略（AI 小万 v1.5.5）

## 可用模型

只允许：

```text
GLM-5.2
DeepSeek V4 Pro
```

禁止 fallback 到其他模型。任一模型不可用时，当前阶段必须 `warn|failed`，不得替换。

## daily 模式

```text
evidence_pack → GLM-5.2 生成 → DeepSeek V4 Pro 复核 → 确定性合并
```

| 角色 | 模型 | 输出 | 约束 |
| --- | --- | --- | --- |
| primary_writer | GLM-5.2 | `insights.json`、`summary.md` | 只基于 evidence_pack；每条结论引用 evidence_id |
| reviewer | DeepSeek V4 Pro | `review_notes.md` | 不重写全文，只查错、查漏、降级建议 |
| merge_rule | deterministic | merge_decisions | 不引入第三模型 |

### GLM-5.2 主生成 Prompt 要点

```text
你是经营分析助手。只基于输入 evidence_pack 生成结论。
每条 key_findings / risks / opportunities 必须引用 evidence_id。
不要补充未提供的数据。
known_gaps 只能写成缺口或待确认事项，不能写成确定性原因。
`effective_history_weeks < 8` 或 `analysis_scope=wow_only` 时，禁止 8-10 周趋势结论。`effective_history_weeks` 优先取 `active_process_manifest.history_weeks_available`。
必须输出符合 insights-schema.json 的 JSON，并给出引用 evidence_id 的 summary.md。
```

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
7. 哪些结论应降级 confidence 或改为 pending_business_confirmation。
输出 review_notes，不直接改写最终 insights。
```

## deep_dive 模式

```text
evidence_pack + target_anomalies → DeepSeek V4 Pro 深挖 → GLM-5.2 结构化 → 确定性合并
```

| 角色 | 模型 | 输出 | 约束 |
| --- | --- | --- | --- |
| primary_analyst | DeepSeek V4 Pro | 深挖草稿 | 只分析指定异常对象；所有原因引用 evidence_id |
| formatter | GLM-5.2 | 结构化 insights / deep_dive 摘要 | 压缩为 schema；不得新增事实 |
| merge_rule | deterministic | merge_decisions | 无证据不保留 |

### DeepSeek V4 Pro 深挖 Prompt 要点

```text
你是经营分析专家。只分析指定异常对象。
基于 evidence_pack 构造可能归因链条，所有原因必须引用 evidence_id。
无法确认的内容标注 pending_business_confirmation。
涉及 board_metrics_feishu.csv、核心机型知识缺失等 known_gap 时，不做确定性结论。
```

### GLM-5.2 结构化 Prompt 要点

```text
你是结构化编辑器。只把 DeepSeek 草稿中有 evidence_id 的内容转成 insights-schema.json。
不得新增新事实、不得改变 evidence_id、不得把 pending 事项改成 confirmed。
```

## 确定性合并规则

| 场景 | 处理 |
| --- | --- |
| 两模型一致且有证据 | 保留；`confidence=high` |
| reviewer 指出证据不足 | 降级 `confidence=low`，必要时改 `rule_status=pending_business_confirmation` |
| reviewer 发现遗漏且 evidence_id 存在 | 补充到 key_findings/risks；记录 merge_decision |
| 归因冲突 | 并列可能原因，待运营确认 |
| 涉及 known_gap | 不做确定性结论 |
| 缺 evidence_id | 删除或转入 data_quality_notes |
