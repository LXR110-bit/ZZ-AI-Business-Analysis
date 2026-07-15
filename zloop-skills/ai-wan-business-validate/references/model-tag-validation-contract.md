# AI 小万机型标签校验契约（Validate 阶段）

## 1. 校验目标

Validate 阶段负责确认标签快照、标签知识、evidence 和最终洞察之间的引用关系可信，防止出现：

- 使用过期标签；
- LLM 自行推断标签；
- 飞书知识库摘要被误当 source of truth；
- insight 声称“核心 / 分层”但没有证据回链；
- snapshot 与 knowledge sha 不一致。

## 2. 必读输入

```text
active_process_manifest.json
active_analysis_manifest.json
model_tag_snapshot_<run_dt>.json
model_tag_knowledge_<run_dt>.json
evidence_pack_<run_dt>.json
insights_<run_dt>.json
summary_<run_dt>.md
analysis_trace_<run_dt>.json
```

前置一致性：

```text
process.run_dt == analysis.run_dt == 当前 run_dt
model_tag_snapshot.run_dt == 当前 run_dt
model_tag_knowledge.run_dt == 当前 run_dt
model_tag_knowledge.source_snapshot_sha256 == model_tag_snapshot.sha256
active_process_manifest.model_tag_knowledge_sha256 == model_tag_knowledge.sha256
```

## 3. 规则校验项

### 3.1 Snapshot / Knowledge

- `schema_version` 必须分别为 `model_tag_snapshot/v1`、`model_tag_knowledge/v1`；
- `source_of_truth` 必须为 `model-tag-monitor-server-front-end-tags`；
- `stats.tagged_model_count` 与 `entries.length` 一致；
- `category_summaries` 与 `model_enrichment` 非空；
- `consumer_contract.missing_tag_policy` 必须存在；
- 若使用 file fallback，`known_gaps` / validation_report 必须记录。

### 3.2 Evidence

对 `model_contributors`：

- 若 insight 涉及机型分层，相关 evidence 必须有 `tag_enrichment`；
- `tag_enrichment.tag_status=tagged` 时，join key 必须存在于 `model_tag_knowledge.model_enrichment`；
- `tag_status=untagged` 时，只能写“未打标”，不能写“非核心 / 长尾 / 低价段”；
- 自定义维度名和值必须来自 `custom_dimensions`，不得新增临时标签。

对 `category_top_changes`：

- 若使用 `category_tag_context`，其 category 必须存在于 `category_summaries`；
- 标签覆盖不足时，必须在 evidence 或 data_quality_notes 中说明覆盖口径。

### 3.3 Insights / Summary

- 每条涉及“核心机型 / A层 / 高价段 / 生命周期”的 insight 必须引用存在的 `evidence_id`；
- `summary.md` 不得声称飞书知识库是标签源；
- 不得把运营备注当作唯一归因证据；
- 不得在标签缺失情况下让 LLM 补全标签；
- 若标签同步失败，所有标签分层相关 insight 必须降级或移除。

## 4. validation_report 建议字段

```json
{
  "model_tag_validation": {
    "status": "pass|warn|failed",
    "snapshot_sha256": "",
    "knowledge_sha256": "",
    "tagged_model_count": 0,
    "category_count": 0,
    "checks": [
      { "name": "snapshot_schema", "status": "pass" },
      { "name": "knowledge_snapshot_sha", "status": "pass" },
      { "name": "evidence_tag_enrichment", "status": "pass" },
      { "name": "no_llm_tag_inference", "status": "pass" }
    ],
    "warnings": [],
    "errors": []
  }
}
```

## 5. 裁决规则

- Snapshot 或 Knowledge 缺失：`analysis_status=failed`；
- sha 不一致：`overall_status=failed`；
- 标签 API 失败但 file fallback 成功：`overall_status=warn`，标签结论允许但必须标注 fallback；
- evidence 缺少 tag_enrichment 但 insight 未使用标签结论：可 `warn`；
- insight 使用标签结论但 evidence 无回链：`analysis_status=failed`；
- 飞书摘要同步失败：不阻塞分析，可 `warn`，但必须写入 `known_gaps`。
