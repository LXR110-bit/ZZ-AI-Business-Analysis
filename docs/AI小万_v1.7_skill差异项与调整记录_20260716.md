# AI小万 v1.7/最新 Skill 差异项与调整记录

生成时间：2026-07-16

## 对照范围

- 远端 active Skill：`zloop skill-forge skills --keyword AI小万` 拉取的 5 个当前生效包。
- 当前本地 v1.6：`zloop-skills/ai-wan-v16-*`。
- 老版 v1.5.5：`zloop-skills/ai-wan-data-fetch`、`ai-wan-data-process`、`ai-wan-business-analyze`、`ai-wan-business-validate`。

远端 active 名称仍是 `v1.6`，但 active version 已到 5/7；本报告按“v1.7/最新”理解为这批远端 active 包。

## 总体差异

| 模块 | 远端 active 状态 | 本地 v1.6 状态 | v1.5.5 基线能力 | 问题 | 本次调整 |
| --- | --- | --- | --- | --- | --- |
| 数据读取 read | 只有 `SKILL.md`、manifest、brief | 原本同样缺 SQL/playbook/scripts | 有 query-playbook、6 份 SQL、`package-raw-cache.js`、`xinghe-data-explore` 委托 | read 只写“跑 SQL”，没有具体 SQL、取数委托和 raw_cache 契约 | 已迁入 SQL/playbook/bin/lib/test，改为 v1.6.3 read 契约，manifest 增加 `xinghe-data-explore` 与 `zloop_runtime` |
| 数据处理 process | 只有 `SKILL.md`、manifest、brief | 原本同样缺 process pipeline/reference | 有 `process-raw-cache.js`、`process-pipeline.js`、标签/服务器缓存契约、snapshot | process 只写“模板处理”，无法复用服务器加工语义 | 已迁入 bin/lib/test/reference/snapshot，改为 v1.6.3 process 契约，输出 `processed_data` |
| 经营分析 analyze | 远端 active 仍是 1.6.2 简版 | 本地已升级 1.6.3 | 有 evidence/model/schema/knowledge 契约 | 远端缺 v1.5.5 分析核心迁移 | 本地已有修复：GLM-5.2 主生成、DeepSeek V4 Pro 复核、evidence_pack、schema |
| 结果校验 validate | 有 APIHub 脚本和契约 | 与远端基本一致 | 有 validation contract、schema、model-tag 校验 | v1.6 validate 更偏最终写服务器，老版细项校验未完全迁入 | 本轮未扩 validate，建议下一步补 v1.5.5 的过度归因、核心机型遗漏、LLM 白名单校验 |
| 主编排 orchestrator | 有 APIHub 脚本和 4 阶段串联说明 | 与远端基本一致 | v1.5.5 是多 Loop，无主编排 | read/process 描述过粗，容易只传抽象结果 | 已升级到 1.6.3 描述，明确 read 产出 raw_cache，process 产出 analysis_history/model_tag_knowledge/data_quality_report |

## 2026-07-16 追加调整原则

用户补充的搭建原则：

- 取数 Skill 需要保存完整 SQL 模板和本轮渲染后的 SQL。
- 数据处理需要和旧服务器上的数据逻辑一致。
- 数据分析需要调用之前的 5 层分步分析法得出结论。
- 数据校验也需要和旧服务器的逻辑一致。
- 在上述基础上融合新版 v1.6 zloop 单 Loop、五阶段调用、APIHub 最终写入逻辑。

本轮已落实：

- read：明确 `references/sql/*.sql` 必须随包保存完整模板，本轮执行后的 SQL 必须保存到 `raw_cache/sql/`，并在 `sql_status` 记录 sha256。
- process：明确 v1.5.5/旧服务器数据逻辑是验收基线，不得用 v1.6 阶段简化跳过；继续复用 `process-pipeline.js`。
- analyze：新增 `references/five-layer-analysis-method.md`，把五层流程固化为“数据守门 → 指标拆解 → 归因假设 → 双模型复核 → 输出断言”。
- validate：迁入 v1.5.5 `insights-schema.json` 与 `model-tag-validation-contract.md`，并把 validate 改为旧逻辑深校验 + v1.6 APIHub write/reread。

## 关键缺口明细

### 1. read 阶段丢失 SQL 和星河委托

远端 active 与原本地 v1.6 read 包都缺少：

- `references/query-playbook.md`
- `references/sql/category_daily_avg.sql`
- `references/sql/category_summary.sql`
- `references/sql/category_fulfill_daily_avg.sql`
- `references/sql/category_fulfill_summary.sql`
- `references/sql/model_daily_avg.sql`
- `references/sql/model_summary.sql`
- `bin/package-raw-cache.js`
- `lib/package-raw-cache.js`
- `test/package-raw-cache.test.js`

影响：

- 运行时不知道执行哪 6 份 SQL。
- 没有 `xinghe-data-explore` 强委托，Loop 容易在 data-analysis-sandbox 中空描述。
- 没有 `raw_cache/active_fetch_manifest/sql_status/raw_manifest`，process 无稳定输入。

调整：

- 将上述文件迁入 `zloop-skills/ai-wan-v16-data-read/`。
- `SKILL.md` 升级为 `version: 1.6.3`，明确必须加载 query-playbook、6 份 SQL，并通过 `$xinghe-data-explore` 取数。
- manifest 增加 `dependencies.skills=[xinghe-data-explore]`、`dependencies.runtime=[zloop_runtime]`。

### 2. process 阶段丢失确定性加工链路

远端 active 与原本地 v1.6 process 包都缺少：

- `bin/process-raw-cache.js`
- `lib/process-pipeline.js`
- `test/process-pipeline.test.js`
- `references/model-tag-sync-contract.md`
- `references/server-flow-mapping.md`
- `references/server-snapshot/*`

影响：

- 无法复用 v1.5.5/服务器的 `day_cnt` 周日均、rolling/final、`KEEP_WEEKS=10`、标签快照和 server cache bundle 语义。
- analyze 阶段拿不到稳定的 `analysis_history/model_tag_knowledge/data_quality_report`。

调整：

- 将上述文件迁入 `zloop-skills/ai-wan-v16-data-process/`。
- `SKILL.md` 升级为 `version: 1.6.3`，明确 process 消费 read 的 raw_cache，禁止跑 SQL/LLM/APIHub。
- manifest 增加 `zloop_runtime`，并标注 `process_core_contract_version=ai-wan-v1.5.5-process`。

### 3. analyze 远端 active 落后于本地修复

远端 active analyze 包文件只有：

- `SKILL.md`
- `references/api-playbook.md`
- `references/apihub-read-write-contract.md`
- `scripts/aiwan_apihub.py`
- manifest/brief

本地 v1.6 analyze 已多出：

- `references/evidence-contract.md`
- `references/insights-schema.json`
- `references/model-adaptation.md`
- `references/model-tag-knowledge-contract.md`

影响：

- 如果继续使用远端 active，分析 prompt 仍是 1.6.2 简版，容易丢失 v1.5.5 的证据链、模型白名单、schema 和知识口径。

调整状态：

- 本地已经继续修到 `contract_version=ai-wan-v1.6.4-analyze`，并新增五层分析法 reference；尚未发布到远端 active。

### 4. orchestrator 对 read/process 产物描述不足

原 orchestrator 只说：

- read 返回 `read_result/sql_result`
- process 返回 `processed_data`

缺少：

- read 必须委托星河并产出 `raw_cache/active_fetch_manifest/sql_status/raw_manifest`
- process 必须运行 process pipeline 并产出 `analysis_history/model_tag_knowledge/data_quality_report`

调整：

- `SKILL.md` 升级为 `version: 1.6.3`。
- manifest contract 升级为 `ai-wan-v1.6.3-stage`。

### 5. validate 需要旧服务器深校验，而不是只做轻量字段检查

原 v1.6 validate 只检查 `processed_data` / `analysis_result` 的基本字段并写服务器。

旧服务器/v1.5.5 需要覆盖：

- lineage/run_id/week 一致性；
- 数据质量、history_weeks、rolling/final、known_gaps；
- evidence_id 存在性与 schema；
- LLM 白名单；
- known_gap 使用；
- 过度归因；
- 核心机型遗漏；
- 高严重度异常遗漏；
- 输出安全；
- 可写服务器 payload readiness。

调整：

- v1.6 validate 升级为 `version: 1.6.4`。
- 迁入 `references/insights-schema.json` 与 `references/model-tag-validation-contract.md`。
- manifest 标记 `validation_core_contract_version=ai-wan-v1.5.5-validation`。

## 校验结果

已执行：

```bash
node zloop-skills/ai-wan-v16-data-read/test/package-raw-cache.test.js
node zloop-skills/ai-wan-v16-data-process/test/process-pipeline.test.js
zloop skill-forge package-check zloop-skills/ai-wan-v16-data-read --mode create
zloop skill-forge package-check zloop-skills/ai-wan-v16-data-process --mode create
zloop skill-forge package-check zloop-skills/ai-wan-v16-orchestrator --mode create
zloop skill-forge package-check zloop-skills/ai-wan-v16-business-analyze --mode create
zloop skill-forge package-check zloop-skills/ai-wan-v16-result-validate --mode create
```

结果：

- read/process 本地测试通过。
- read/process package-check 0 warning 通过。
- orchestrator/analyze/validate package-check 通过，仅提示 Python AST 检查被 Go 校验器跳过，需要人工/运行时验证。

## 待发布注意

- `package-check --mode update` 需要平台真实 `base-version-id`，不能直接使用列表里的 active version 数字 5/7。
- 远端 active 仍落后于本地修复，需要拿到真实版本 ID 后走 upload/apply 更新。
- validate 还建议补齐 v1.5.5 的深度校验项：evidence_id、schema、known_gap、LLM 白名单、history_weeks、过度归因、核心机型遗漏。

## 2026-07-16 追加：v1.6.5 display_insights 与服务器 bridge 契约

本轮最新目标改为：服务器 bridge 只发布 `analysis_result.display_insights`，不再从 `findings` 自动生成大盘/分层/品类文案。Skill 必须直接产出旧线上 dashboard 可展示的丰富结构。

### 已落实

- read：升级为 v1.6.5，继续保留完整 SQL 模板、本轮渲染 SQL、raw_cache/read_result 契约。
- process：升级为 v1.6.5，新增飞书 Base「品类映射表」契约：
  - base token：`NKw4b2eKxaKhDTsOrD9cONklnGb`
  - table：`品类映射`
  - 输出 `category_mapping_manifest`
  - `发展/孵化/种子` 进入聚合与分层
  - `自营(非聚合)` 排除聚合/万象大盘分析
  - `已下线` 保留历史，不参与最新周环比
  - 飞书读取失败允许用最近快照，并写入 warning/known_gap
- analyze：升级为 v1.6.5，强制输出：
  - `display_contract = dashboard-business-overview-insights-map/v1`
  - `display_insights.board`
  - `display_insights.tiers.发展/孵化/种子`
  - `display_insights.secondaryCategories`
  - `display_insights.categories`
  - `display_insights.category`
  - `display_insights.monitor`
  - `display_insights.warnings`
- analyze 五层法已修正为飞书真实业务链路：大盘链路定性 → 品类簇/分层判断 → 二级类目/品类下钻 → 机型归因 → 综合判断。
- validate：升级为 v1.6.5，新增 `display_insights_contract` 校验；display 缺失、三层缺失、key 不合法均为 critical failed，`publish_allowed=false`。
- orchestrator：升级为 v1.6.5，明确四阶段传递：read 产出 SQL/raw_cache，process 产出 `processed_data + category_mapping_manifest`，analyze 产出 `findings + display_insights`，validate 校验并最终写服务器。

### 最新校验结果

已执行：

```bash
jq empty zloop-skills/ai-wan-v16-*/skill.manifest.json
jq empty zloop-skills/ai-wan-v16-business-analyze/references/insights-schema.json
jq empty zloop-skills/ai-wan-v16-result-validate/references/insights-schema.json
node --test zloop-skills/ai-wan-v16-data-process/test/process-pipeline.test.js
python3 -m py_compile zloop-skills/ai-wan-v16-business-analyze/scripts/aiwan_apihub.py zloop-skills/ai-wan-v16-result-validate/scripts/aiwan_apihub.py zloop-skills/ai-wan-v16-orchestrator/scripts/aiwan_apihub.py
zloop skill-forge package-check <5个 ai-wan-v16 Skill 目录> --mode update --target-skill-public-id ... --base-version-id ...
```

结果：

- JSON schema/manifest 校验通过。
- process 单测通过，覆盖品类映射 manifest 与 `自营(非聚合)` 排除逻辑。
- Python APIHub helper 语法检查通过。
- 5 个 v1.6 Skill 的 `package-check --mode update` 均通过。
- analyze / validate / orchestrator 仅有 package-check 的 Go AST warning：Python 语法检查被 package-check 跳过；已用 `py_compile` 人工验证。

### 服务器联调入口

远端发布前，服务器 agent 联调应检查：

- validate final 写入 payload 中存在 `analysis_result.display_contract` 与完整 `analysis_result.display_insights`。
- bridge 合法发布后生成 `business-overview-insights-<week>.json`。
- cache 元信息为：
  - `mode: "aiwan_loop"`
  - `generatedBy: "aiwan-v1.6.2-loop"`
  - `inputHash: "aiwan:<run_id>:<revision>"`
- refresh/generate 不覆盖同周 `mode=aiwan_loop` cache。
- 旧 dashboard 页面真实可见大盘、发展/孵化/种子、二级类目、品类和机型分层相关内容。
