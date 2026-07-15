# AI 小万 v1.5.5 知识库与机型分层迁移盘点

## 1. 结论

v1.5.5 首版机型标签 / 分层同步采用“服务器前端打标为源、zloop Process 固化快照、Analyze 只读消费、飞书知识库只收摘要”的方案。

```text
服务器 tags/tag-vocab/rules
  → Process 每日导出 model_tag_snapshot + model_tag_knowledge
  → Analyze 按 category||model_name join 标签分层
  → Validate 校验 sha / evidence 回链 / 禁止 LLM 自行推断
  → 飞书知识库同步摘要（非 source of truth）
```

## 2. 当前 source of truth

服务器现有三类文件：

| 文件 | 作用 | 首版处理方式 |
| --- | --- | --- |
| `model-tag-monitor/data/tags.json` | 机型打标记录，key 为 `category||modelName` | 每日快照；保留 `dimensions / tags / note` |
| `model-tag-monitor/data/tag-vocab.json` | 全局与品类自定义标签字典 | 每日快照；生成 `dimension_catalog` |
| `model-tag-monitor/data/rules.json` | 监测规则 | 每日快照；缺失时使用 `monitor.DEFAULT_RULES` 并标记 warning |

本地盘点（2026-07-15，file source dry-run）：

- `tags.json`：1007 个已打标 key；
- 当前覆盖品类：`内存条`；
- 当前维度赋值：1007；
- 当前自定义维度：2；
- `rules.json` 本地数据目录缺失，脚本会 fallback 到默认规则并输出 warning。

以上数量来自当前工作区样本，不代表生产最终覆盖。

## 3. API 与前端保存逻辑盘点

### 3.1 `/api/tags`

`GET /api/tags`：

- 读取 `tag-vocab.json` 并执行 `normalizeTagVocab`；
- 读取 `tags.json` 并执行 `normalizeTagsStore`；
- 返回规范化后的 tags；
- GET 额外保留 `tags: []` 兼容旧前端展示。

`PUT /api/tags/:key`：

- key 必须包含 `||`，格式为 `category||modelName`；
- 用当前 vocab 对请求体执行 `normalizeTagRecord`；
- 保存到 `tags.json`；
- 写 `operations.log`，action=`tag-update`。

`POST /api/tags/import`：

- 支持 `mode=merge|replace`；
- 逐条 normalize；
- 非 `category||modelName` key 会跳过；
- 写 `operations.log`，action=`tag-import`。

### 3.2 `/api/tag-vocab`

`GET /api/tag-vocab` 返回规范化字典。

`PUT /api/tag-vocab`：

- 保存全局维度：`core / lifecycle / price`；
- 保存品类自定义维度：`custom[category] = [{ id, name, options[] }]`；
- v1.5 不迁移旧结构 `custom[category]=['标签A']`；
- 前端保存时会校验品类名来自当前数据品类，且每个自定义维度必须有名称和 options。

### 3.3 `/api/rules`

`GET /api/rules` 读取 `rules.json`，缺失时返回 `DEFAULT_RULES`。

`PUT /api/rules`：

- 将请求体 merge 到当前规则；
- `rates` 固定回 `DEFAULT_RULES.rates`，不允许前端修改；
- 保存后会 `invalidateDashboardCache()`；
- 写 `operations.log`，action=`rules-update`。

### 3.4 前端打标保存逻辑

`public/app.js` 标签弹窗保存时：

- 单机型保存：读取每个维度的 `<select>`，生成 `dimensions`；
- 批量保存：按勾选机型逐个 PUT `/api/tags/:key`；
- 保存体核心字段是 `{ dimensions, note }`；
- 前端本地会同步更新 `state.tags[key] = { dimensions, note }`；
- 导出配置时并行拉取 `/api/tags`、`/api/tag-vocab`、`/api/rules`，组成 bundle。

## 4. 本次新增导出脚本

新增：

```text
model-tag-monitor/scripts/export-model-tag-snapshot.js
```

职责：

- 支持 API 拉取 `/api/tags`、`/api/tag-vocab`、`/api/rules`；
- 支持 access-code 换 cookie；
- 支持 file source dry-run / 单测；
- 规范化 tags / vocab / rules；
- 输出 `model_tag_snapshot_<run_dt>.json`；
- 输出 `model_tag_knowledge_<run_dt>.json`；
- 输出 `model_tag_feishu_summary_<run_dt>.md`。

推荐 Process 调用：

```bash
node model-tag-monitor/scripts/export-model-tag-snapshot.js \
  --source api \
  --api-base "$MODEL_TAG_API_BASE" \
  --access-code "$MODEL_TAG_ACCESS_CODE" \
  --out-dir "$PROCESS_ARTIFACT_DIR" \
  --run-dt "$RUN_DT"
```

## 5. 产物设计

### 5.1 `model_tag_snapshot_<run_dt>.json`

定位：可审计的原始标签快照。

包含：

- `source_of_truth=model-tag-monitor-server-front-end-tags`；
- API / file source 信息；
- 统计信息；
- `vocab` 与 `dimension_catalog`；
- `rules`；
- `tags` 原 key map；
- `entries` 展开数组；
- `sha256`。

### 5.2 `model_tag_knowledge_<run_dt>.json`

定位：Analyze 可直接消费的知识结构。

包含：

- `source_snapshot_sha256`；
- `rules_summary`；
- `category_summaries`：每个品类每个维度各取值的机型数与 examples；
- `model_enrichment`：按 `category||model_name` join 的标签增强；
- `feishu_knowledge_summary.markdown`；
- `consumer_contract`。

### 5.3 `model_tag_feishu_summary_<run_dt>.md`

定位：同步到飞书知识库的轻量摘要。

同步原则：

- 只写摘要，不写回 tags；
- 飞书当前不作为 source of truth；
- 同步失败只影响知识库展示，不应让 Analyze 使用旧飞书内容。

## 6. zloop 四阶段接入

### Process

新增 contract：

```text
zloop-skills/ai-wan-data-process/references/model-tag-sync-contract.md
```

Process 输出 active manifest 时应带：

```json
{
  "model_tag_snapshot": "model_tag_snapshot_<run_dt>.json",
  "model_tag_knowledge": "model_tag_knowledge_<run_dt>.json",
  "model_tag_snapshot_sha256": "...",
  "model_tag_knowledge_sha256": "...",
  "model_tag_source": "model-tag-monitor-server-front-end-tags"
}
```

### Analyze

新增 contract：

```text
zloop-skills/ai-wan-business-analyze/references/model-tag-knowledge-contract.md
```

Analyze 必须：

- 读取 `model_tag_knowledge`；
- 用 `category||model_name` join；
- 对未命中的机型标记 `未打标`；
- 在 `model_contributors` evidence 里追加 `tag_enrichment`；
- LLM 不允许自行推断标签。

### Validate

新增 contract：

```text
zloop-skills/ai-wan-business-validate/references/model-tag-validation-contract.md
```

Validate 必须校验：

- run_dt 一致；
- snapshot / knowledge sha 串联；
- insight 的标签结论有 evidence_id 回链；
- 飞书摘要不是标签源；
- 缺失标签不得被写成“非核心”。

## 7. 风险与缺口

| 风险 | 影响 | v1.5.5 处理 |
| --- | --- | --- |
| 生产 API 有门禁 | Process 拉取失败 | 支持 access-code / cookie；失败可 file fallback 并 warn |
| `rules.json` 缺失 | 规则口径不清 | fallback `DEFAULT_RULES`，写 warning |
| 标签覆盖不足 | 分层结论代表性不足 | Analyze 只说“已打标样本”；Validate 检查覆盖提示 |
| 飞书知识库不完善 | 不能回写 | 只同步摘要，不作为源 |
| LLM 自行补标签 | 结论失真 | Analyze prompt 禁止；Validate evidence 回链校验 |
| 其他 agent 同时改 Skill | 契约未被 SKILL.md 引用 | 本轮只新增 references，后续集成时统一挂载 |

## 8. 测试

新增：

```text
model-tag-monitor/test/model-tag-snapshot.test.js
```

覆盖：

- snapshot 规范化；
- legacy `tags: []` 推断 dimensions；
- knowledge 的 category summary / model enrichment；
- file source 导出与 `rules.json` fallback；
- 输出 JSON / Markdown 文件。

已运行：

```bash
node --test model-tag-monitor/test/model-tag-snapshot.test.js
```

结果：3 passed。
