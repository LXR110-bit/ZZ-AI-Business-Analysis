# Dashboard display_insights 契约

本契约定义 Analyze 输出给旧服务器 dashboard bridge 的页面展示主结构。服务器 bridge 只发布本结构，不生成业务判断、不补分层结论、不修正文案口径。

## 输出位置

`analysis_result` 必须同时包含：

```json
{
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
  }
}
```

`findings` 继续保留用于追溯，但 dashboard 页面主消费对象是 `display_insights`。

## 字段语义

| 字段 | 页面用途 | 生成来源 |
| --- | --- | --- |
| `board` | 大盘洞察条 | Skill 1 大盘链路定性和风险等级 |
| `tiers.发展/孵化/种子` | 分层洞察条 | Skill 2 品类簇/分层判断 |
| `secondaryCategories` | 选中二级类目洞察条 | Skill 3 二级类目归因 |
| `categories` | 选中品类洞察条 | Skill 3/4 品类与机型下钻 |
| `category` | 全局品类概览 | Skill 5 综合判断 |
| `monitor` | 监测说明 | Skill 5 数据范围、缺口、观察建议 |
| `warnings` | 页面 warning | 口径不确定、低基数、缺失数据、key 未匹配等 |

## key 规则

- `tiers` 必须固定包含且只包含核心三层：`发展`、`孵化`、`种子`。如有 `自营(非聚合)`，不得进入聚合/万象大盘分析。
- `secondaryCategories` 的 key 只能来自 processed_data/server_context/dashboard/category snapshot 中真实存在的 `secondaryCategory` 或 `board`。
- `categories` 的 key 只能来自 processed_data/server_context/dashboard/category snapshot 或品类映射表中真实存在的三级品类。
- 禁止 fuzzy match，禁止把 overall finding 塞进 category/secondary map。
- 未匹配 finding 只能进入 `board`、`monitor`、`warnings` 或保留在 `findings`。

## 口径来源

Analyze 的 `business_scope` / `data_scope` 必须来自：

- `processed_data.business_scope` / `processed_data.data_scope`
- `processed_data.active_process_manifest`
- APIHub read 返回的 `server_context.run_meta/rules/dashboard_snapshot`
- dashboard 当前 week 的 `metric_snapshot`、`candidate_anomalies`、`history_10w`

禁止自行写未被证明的口径词，例如“上门回收”“全渠道”“聚合回收”。若口径不确定，写入 `display_insights.warnings` 与 `analysis_result.warnings`，页面文案降级为观察。

## 文案风格

- 使用短段落，不用 markdown bullet，不用表格。
- 每段结构：结论 + 关键证据 + 下钻/观察建议。
- 指标使用中文名：机况UV、估价UV、下单UV、发货数、成交订单、成交GMV、下单率、发货率、成交率。
- 百分点写“0.80个百分点”，不要写 `pct`、`pp`。
- 不泄漏技术字段名：`orderRate`、`shipCnt`、`dealGmv`、`wow_pct`、`entity_type` 等只能留在结构化字段，不得出现在展示文案。
- 不直接给调价、补贴、投放等强策略动作，只给下钻方向、风险确认、观察建议。

## 丰富度要求

- `board/category/monitor` 必须为非空字符串。
- `tiers.发展/孵化/种子` 必须为非空字符串，且不能只是“暂无异常”“数据不足请关注”这类空泛兜底。
- 每个分层文案必须包含对应层的指标证据，或明确的数据风险说明。
- `secondaryCategories/categories` 必须覆盖 dashboard snapshot 中本周有有效数据的对象；低基数对象也要生成指标型短评，并在文案或 warnings 中说明低基数风险。
- 机型、标签、分层相关内容优先落到对应 `categories[品类名]` 文案中，不能只存在 findings。
