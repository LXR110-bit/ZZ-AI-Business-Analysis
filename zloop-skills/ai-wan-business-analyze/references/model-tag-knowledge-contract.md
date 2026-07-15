# AI 小万机型标签知识消费契约（Analyze 阶段）

## 1. 输入

Analyze 阶段除 `analysis_history_<run_dt>.json` 外，必须读取 Process 产物：

```text
model_tag_knowledge_<run_dt>.json
```

推荐同时读取：

```text
model_tag_snapshot_<run_dt>.json
active_process_manifest.json
```

前置检查：

```text
active_process_manifest.stage == process
active_process_manifest.status in [success, warn]
active_process_manifest.run_dt == 当前 run_dt
model_tag_knowledge.schema_version == model_tag_knowledge/v1
model_tag_knowledge.source_snapshot_sha256 == model_tag_snapshot.sha256
sha256 校验通过
```

## 2. Join 规则

标签 join key：

```text
category||model_name
```

从 evidence 的 `category` 和 `model_name` 拼接。若 evidence 只有 `model_id`，不得猜测标签，必须先有可回链的 `category + model_name`。

缺失策略：

```text
treat_as_未打标_and_do_not_infer_core/lifecycle/price
```

LLM 不允许根据机型名称自行推断“核心 / 新品 / 高价段 / A层”。

## 3. 可消费字段

`model_enrichment` 用于逐机型证据增强：

```json
{
  "core": "核心",
  "lifecycle": "主流",
  "price": "高价段",
  "custom_dimensions": { "A/B层": "A层" },
  "tags": ["核心", "主流", "高价段", "A层"],
  "note": "运营备注"
}
```

`category_summaries` 用于品类层结构化背景：

- 当前品类有哪些标签维度；
- 各维度取值下的机型数量；
- 代表机型 examples；
- 带备注机型数量。

`rules_summary` 用于解释监测池口径：

- `pool_top_n`
- `wave_threshold`
- `trend_weeks`
- `min_eva_uv`
- `rates`

## 4. evidence_pack 增强

Analyze 生成 `evidence_pack_<run_dt>.json` 时，应在 `model_contributors` 中追加标签字段：

```json
{
  "evidence_id": "MODEL_CONTRIB_001",
  "category": "品类",
  "model_name": "机型",
  "tag_enrichment": {
    "tag_status": "tagged|untagged",
    "core": "核心|非核心|观察|未打标",
    "lifecycle": "新品|主流|长尾|淘汰|未打标",
    "price": "高价段|中价段|低价段|未打标",
    "custom_dimensions": {},
    "note": ""
  }
}
```

品类证据可追加：

```json
{
  "category_tag_context": {
    "tagged_model_count": 0,
    "top_dimensions": [
      { "label": "核心度", "values": [{ "value": "核心", "model_count": 10 }] }
    ]
  }
}
```

## 5. LLM 提示约束

传给 GLM-5.2 / DeepSeek V4 Pro 的标签知识必须来自 `model_tag_knowledge`，并保留 `source_snapshot_sha256`。提示中应明确：

- 标签是运营前端打标快照，不是模型自动判断；
- 未打标不等于非核心；
- 飞书知识库摘要不是 source of truth；
- 任何“核心机型拖累 / A层机型拉动”等结论必须回链到带 `tag_enrichment` 的 `evidence_id`。

禁止：

- 把全量 snapshot 原样塞给 LLM；
- 让 LLM 重新分类标签；
- history 不足时用标签分层包装成 10 周趋势结论；
- 因标签备注存在就替代量化证据。

## 6. 输出表达建议

可用表达：

```text
在已打标机型中，核心机型贡献了本周组装机 GMV 增量的 62%（evidence: MODEL_CONTRIB_003）。
```

不可用表达：

```text
该机型看起来是高价核心机型，因此应该重点投入。
```

如果标签覆盖不足，应降级表达：

```text
当前标签覆盖不足，仅能说明已打标样本中的结构变化，不能代表全品类。
```
