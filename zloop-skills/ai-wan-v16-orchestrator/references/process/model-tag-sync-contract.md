# AI 小万机型标签同步契约（Process 阶段）

## 1. 目的

Process 阶段在每日数据处理完成前后，必须把旧服务器前端打标结果固化成当天可审计产物，供 Analyze 阶段做机型分层解释，并生成可同步到飞书知识库的摘要。

首版 source of truth 固定为服务器侧：

```text
model-tag-monitor/data/tags.json
model-tag-monitor/data/tag-vocab.json
model-tag-monitor/data/rules.json
```

对应 API：

```text
GET /api/tags
GET /api/tag-vocab
GET /api/rules
```

飞书知识库只接收摘要，不作为 v1.5.5 首版写入源或回写源。

## 2. 生成方式

推荐在 Process Loop 中调用：

```bash
node model-tag-monitor/scripts/export-model-tag-snapshot.js \
  --source api \
  --api-base "$MODEL_TAG_API_BASE" \
  --access-code "$MODEL_TAG_ACCESS_CODE" \
  --allow-file-fallback \
  --fallback-data-dir model-tag-monitor/data \
  --feishu-doc "$FEISHU_KNOWLEDGE_DOC" \
  --out-dir "$PROCESS_ARTIFACT_DIR" \
  --run-dt "$RUN_DT"
```

可选认证方式：

- `MODEL_TAG_ACCESS_CODE`：脚本先调用 `/api/access/verify` 换取 HttpOnly 门禁 cookie；
- `MODEL_TAG_API_COOKIE` / `API_COOKIE`：已有 cookie 时直接带入；
- dry-run / 单测可用 `--source file --data-dir model-tag-monitor/data`；
- `--allow-file-fallback`：API 不可用时从本地 data 目录降级生成快照，并在 manifest `known_gaps` 写入 `model_tag_api_unavailable_used_file_fallback`；
- `FEISHU_KNOWLEDGE_DOC` / `--feishu-doc`：飞书 Wiki/Doc 摘要页 URL 或 token；配置后脚本用 `lark-cli docs +update --command overwrite --doc-format markdown` 覆盖写入摘要。未配置或写入失败不影响 Analyze 消费，但会写入 `feishu_knowledge_summary_sync_*` known_gap。

Process 阶段不调用 LLM。

## 3. 输出产物

```text
model_tag_snapshot_<run_dt>.json
model_tag_knowledge_<run_dt>.json
model_tag_feishu_summary_<run_dt>.md
model_tag_sync_manifest_<run_dt>.json
```

`model_tag_feishu_summary_<run_dt>.md` 是飞书知识库摘要写入内容；它不参与下游事实 join，可缺省重建。`model_tag_sync_manifest_<run_dt>.json` 记录本次 snapshot/knowledge sha256、source、飞书同步状态与 known_gaps，供 Process 合并进 `active_process_manifest.json`。

## 4. model_tag_snapshot 字段

最小结构：

```json
{
  "schema_version": "model_tag_snapshot/v1",
  "artifact_type": "model_tag_snapshot",
  "run_id": "model_tag_sync_YYYY-MM-DD",
  "run_dt": "YYYY-MM-DD",
  "generated_at": "ISO-8601",
  "source_of_truth": "model-tag-monitor-server-front-end-tags",
  "source": {
    "mode": "api",
    "api_base": "https://...",
    "endpoints": ["/api/tags", "/api/tag-vocab", "/api/rules"]
  },
  "stats": {
    "tagged_model_count": 0,
    "category_count": 0,
    "dimension_assignment_count": 0,
    "custom_dimension_count": 0
  },
  "vocab": {},
  "dimension_catalog": {},
  "rules": {},
  "tags": {
    "品类||机型": {
      "dimensions": { "core": "核心" },
      "tags": ["核心"],
      "note": ""
    }
  },
  "entries": [],
  "sha256": "..."
}
```

`tags` 保留服务器 key 形态；`entries` 是下游更易 join 的展开数组。

## 5. model_tag_knowledge 字段

最小结构：

```json
{
  "schema_version": "model_tag_knowledge/v1",
  "artifact_type": "model_tag_knowledge",
  "run_id": "",
  "run_dt": "YYYY-MM-DD",
  "source_snapshot_sha256": "",
  "rules_summary": {},
  "dimension_catalog": {},
  "category_summaries": [],
  "model_enrichment": {
    "品类||机型": {
      "category": "品类",
      "model_name": "机型",
      "core": "核心|非核心|观察|",
      "lifecycle": "新品|主流|长尾|淘汰|",
      "price": "高价段|中价段|低价段|",
      "custom_dimensions": {},
      "all_dimensions": {},
      "tags": [],
      "note": ""
    }
  },
  "feishu_knowledge_summary": {
    "write_mode": "summary_only_not_source_of_truth",
    "markdown": "..."
  },
  "consumer_contract": {
    "join_key": "category||model_name",
    "missing_tag_policy": "treat_as_未打标_and_do_not_infer_core/lifecycle/price"
  },
  "sha256": "..."
}
```

## 6. active_process_manifest 接入

Process 成功时必须在 `active_process_manifest.json` 增加或保留：

```json
{
  "model_tag_snapshot": "model_tag_snapshot_<run_dt>.json",
  "model_tag_knowledge": "model_tag_knowledge_<run_dt>.json",
  "model_tag_snapshot_sha256": "...",
  "model_tag_knowledge_sha256": "...",
  "model_tag_source": "model-tag-monitor-server-front-end-tags",
  "model_tag_stats": {
    "tagged_model_count": 0,
    "category_count": 0
  },
  "feishu_sync": {
    "status": "success|dry_run|not_configured|failed",
    "write_mode": "summary_only_not_source_of_truth"
  },
  "known_gaps": []
}
```

如果 API 拉取失败，但 file fallback 成功，`status` 可为 `warn`，并在 `known_gaps` 写明 `model_tag_api_unavailable_used_file_fallback`。如果 snapshot / knowledge 均无法生成，Process 不应输出 success。

## 7. 质量门禁

Process 阶段至少校验：

- `run_dt` 与当前 Process run 一致；
- `schema_version` 分别为 `model_tag_snapshot/v1`、`model_tag_knowledge/v1`；
- `source_snapshot_sha256 == snapshot.sha256`；
- `model_tag_knowledge.model_enrichment` 非空（除非当天明确无标签并降级 warn）；
- `tags.json` key 必须为 `category||modelName`；
- `tag-vocab.json` 自定义维度必须是 `{ id, name, options[] }` 结构；
- `rules.rates` 使用服务器固定监测指标，不允许下游自行改写。

## 8. 飞书知识库同步

Process 输出的 `model_tag_feishu_summary_<run_dt>.md` 由 exporter 在配置 `FEISHU_KNOWLEDGE_DOC` 后直接同步到知识库 Doc/Wiki 页面；也可由服务器或单独 Feishu 写入任务复用该 Markdown。

同步规则：

- 只写摘要：类别、维度、分层数量、Top 示例；
- 不把飞书文档内容反向合并到 `tags.json`；
- 写入失败不阻塞数据分析，但必须在 `known_gaps` 标记 `feishu_knowledge_summary_sync_failed`；
- 后续若飞书知识库升级为 source of truth，必须另起 schema version，不能静默替换本契约。
