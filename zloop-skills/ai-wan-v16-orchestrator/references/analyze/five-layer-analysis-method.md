# AI 小万五层分步分析法（飞书方法论 v0.4）

本方法来自飞书 Wiki「大盘_品类_机型漏斗数据分析」的人类阅读版框架。Analyze 阶段必须按 5 个业务 Skill 链顺序推进；它不是泛化的“先算数再写结论”，而是固定的经营判断链。

## 总原则

- 分析链：Skill 1 -> 2 -> 3 -> 4 -> 5，自下而上从数据推出结论。
- 表达链：Skill 5 输出时倒过来，用金字塔原理结论先行。
- 每个结论必须回答老板四问之一：大盘安全吗、上周判断对了吗、哪里加注或收手、下周做什么。
- 数据可信度先于一切。若数据同步时点、口径断层或比值异常任一存疑，整份报告结论必须降级为“待核”，风险等级不得为正常。
- 所有页面展示文案最终服务旧 dashboard 结构：大盘、分层、二级类目、品类、监测说明。

## Skill 1：大盘链路定性 + 风险等级

对应输出：`display_insights.board`。

必须完成：

- 做数据可信度三查：同步时点、口径断层、相邻链路比值异常。
- 做三基准对比：环比、4 周前对比、近 8 周均值对比。
- 识别多期趋势：下降通道、上升通道、震荡区间、近 8 周首次突破。
- 做链路传导：机况UV -> 估价UV -> 下单UV -> 发货数 -> 成交订单 -> 成交GMV -> 客单价。
- 做量价拆解：成交GMV = 成交订单 x 客单价。
- 给风险等级：危险、警告、正常。

输出要求：

- `board` 必须是短段落，结构为“结论 + 关键证据 + 下钻/观察建议”。
- 若口径不确定，必须写成数据风险或观察项，不得写确定性业务结论。
- 大盘口径必须来自 `processed_data` 或 APIHub read 的 `server_context`，不得自行写“上门回收”“全渠道”“聚合回收”等未证明口径词。

## Skill 2：品类簇归因 + 策略验证

对应输出：`display_insights.tiers.发展`、`display_insights.tiers.孵化`、`display_insights.tiers.种子`。

必须完成：

- 三个分层固定都要产出：发展、孵化、种子。
- 分层归属来自 processed_data/server_context/dashboard snapshot/category mapping，不得硬编码。
- 对每层分别判断流量端与转化端：估价UV、下单UV、成交订单、成交GMV、下单率、发货率、成交率。
- 用责任主体 x 时间属性做归因二维矩阵：市场行情、我方动作、竞对动作、用户结构变化、不可归因；一次性事件、短期波动、结构性趋势。
- 与 Skill 1 发生标签冲突时执行交叉仲裁，不强行统一。

输出要求：

- 三层文案不能为空泛兜底。每层必须包含对应层的指标证据，或明确说明该层数据缺失/低基数/口径风险。
- 不允许服务器 bridge 生成伪 AI 分层判断；Analyze 必须直接生成三层文案。
- 低基数或样本不足时，写“维持观察”或“数据风险”，不得写强行动作。

## Skill 3：品类下钻 + 影响度 + 停止条件

对应输出：`display_insights.secondaryCategories` 与 `display_insights.categories`。

必须完成：

- 二级类目 key 只能来自 dashboard/category snapshot 中真实存在的 `secondaryCategory` 或 `board`。
- 品类 key 只能来自 dashboard/category snapshot 或 category mapping 中真实存在的三级品类。
- 禁止 fuzzy match；未匹配 finding 只能进入 `board`、`monitor`、`warnings` 或保留在 `findings`。
- 对异常品类计算影响度、可解决度、是否值得继续下钻。
- 判断品类间此消彼长：内部竞争、外部流失、跨簇转移。

输出要求：

- 二级类目文案服务当前选中二级类目洞察条。
- 品类文案服务当前选中品类洞察条。
- 每段必须有证据来源，不能把 overall finding 塞进 category/secondary map。

## Skill 4：机型归因 + 规律复用

对应输出：`display_insights.categories` 中相关品类文案的机型/标签/分层内容，必要时补充 `findings`。

仅当 Skill 3 判断“值得下钻”时执行。

必须完成：

- 做机型四象限：大体量低转化、大体量高转化、小体量高转化、小体量低转化。
- 若有 model_tag_knowledge，必须使用已存在标签；不得让 LLM 自行打核心机型、生命周期、高价段标签。
- 提炼机型规律：首次发现、规律再验证、规律修正。
- 判断跨品类复用：品牌关联与品类关联。

输出要求：

- 机型结论必须回写到对应品类文案或 findings，不新增 dashboard 不认识的顶层 key。
- 标签缺失时，只能写数据风险或待补齐，不能输出确定性核心机型判断。

## Skill 5：综合判断 + 下周行动

对应输出：`display_insights.category` 与 `display_insights.monitor`，并校准全部展示文案。

必须完成：

- 用金字塔原理做结论先行：单一核心判断 + 关键证据 + 下周观察方向。
- 核心发现按 Q1 大盘安全、Q2 上周判断兑现、Q3 资源怎么动分组，但最终页面文案按旧 dashboard map 落位。
- 输出监测说明：数据范围、已知缺口、低基数、口径风险、下周应观察的链路或对象。

输出要求：

- `category` 是全局品类概览，不是某个单品类文案。
- `monitor` 是监测说明和风险提示，不写成发布日志。
- 不直接给调价、补贴、投放等强策略动作，只给下钻方向、风险确认、观察建议。

## v0.4 六项硬规则

1. 数据可信度校验：同步时点、口径断层、比值异常。
2. 三基准对比：环比、4 周前对比、近 8 周均值。
3. 多期趋势判断：连续 3 周、近 8 周极值、趋势标签。
4. 品类间此消彼长：内部竞争、外部流失、跨簇转移。
5. 归因二维矩阵：责任主体 x 时间属性。
6. 论点交叉仲裁：Skill 1 与 Skill 2/3 的标签冲突必须显式处理。

## 展示文案约束

- 使用短段落，不用 markdown bullet，不用表格。
- 指标用中文名：机况UV、估价UV、下单UV、发货数、成交订单、成交GMV、下单率、发货率、成交率。
- 百分点写“0.80个百分点”，不得写 `pct`、`pp`。
- 每段保持“结论 + 关键证据 + 下钻/观察建议”。
- 对低基数、口径异常、机型缺失，必须明确写为数据风险或维持观察。

## v1.5.5 旧服务器效果对齐补充

- 五层方法必须输出可审计产物，不只输出展示文案：`evidence_pack`、`insights`、`summary`、`review_notes`、`analysis_trace`、`findings`、`display_insights`。
- 每个关键结论必须携带大写前缀 evidence_id，并能在 `evidence_pack.evidence_index` 回链。
- daily 模式保留“GLM-5.2 主生成 + DeepSeek V4 Pro 复核 + 确定性合并”的角色语义；即使实现为确定性规则，也要在 `model_trace` 和 `analysis_trace` 中记录。
- `display_insights` 面向 dashboard 展示，`summary/review_notes/analysis_trace` 面向 validate 与人工审计，二者缺一不可。
- 历史不足 8 周时只能输出周环比观察和验证计划，不能输出长期趋势。
