# Dashboard display_insights 校验契约

Validate 阶段必须把 `analysis_result.display_insights` 当作服务器 bridge 的主消费结构校验。服务器只负责状态、优先级、缓存发布和兼容消费，不负责生成业务判断。

服务器最终契约：

- `/api/aiwan/write` validate final 后，服务器只发布 `analysis_result.display_insights`。
- display 不合法时，服务器保留 validate 写入和 run 状态修复，但 bridge 返回 `{ ok:false, error }`，不生成 `business-overview-insights-<week>.json`。
- display 合法时，服务器生成 cache：
  - `mode: "aiwan_loop"`
  - `generatedBy: "aiwan-v1.6.2-loop"`
  - `inputHash: "aiwan:<run_id>:<revision>"`
- refresh/generate 脚本不会覆盖同周 `mode=aiwan_loop` cache。

## 必须存在

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

## 结构校验

- `display_contract` 必须等于 `dashboard-business-overview-insights-map/v1`。
- `display_insights.board/category/monitor` 必须是非空 string。
- `display_insights.tiers` 必须是 map，且包含 `发展`、`孵化`、`种子` 三个非空 string。
- `display_insights.secondaryCategories` 与 `display_insights.categories` 必须是 map。
- `display_insights.warnings` 必须是数组。
- `display_insights` 必须保留在 `analysis_result` 内随 validate payload 写服务器，不能只复制到 validation summary。

## key 校验

合法 key 来源：

- `processed_data.metric_snapshot`
- `processed_data.server_cache_bundle.category-cache.json` 或等价摘要
- `processed_data.server_cache_bundle.category-taxonomy.json` 或等价摘要
- `processed_data.active_process_manifest`
- APIHub read 返回的 `server_context.dashboard_snapshot`、`history_10w`、`rules`

规则：

- `secondaryCategories` key 必须能匹配真实二级类目或 board。
- `categories` key 必须能匹配真实三级品类。
- 禁止 fuzzy match；无法匹配的 key 为 failed。
- `自营(非聚合)` 不得进入 `tiers`，也不得作为聚合/万象大盘结论。

## 文案校验

禁止展示文案包含：

- 未被 processed_data/server_context 证明的业务口径词：上门回收、全渠道、聚合回收。
- 技术字段：`pct`、`pp`、`wow_pct`、`orderRate`、`shipCnt`、`dealGmv`、`entity_type`、`candidate_anomalies`。
- 越权发布表述：已正式发布、已推飞书、最终通过。
- 强策略动作：直接调价、补贴、投放等确定动作。

必须满足：

- 百分点写“0.80个百分点”。
- 指标使用中文名：机况UV、估价UV、下单UV、发货数、成交订单、成交GMV、下单率、发货率、成交率。
- 三个分层文案不能只是空泛兜底；必须包含对应层指标证据，或明确数据风险/低基数/口径缺失。
- 低基数、口径异常、机型缺失要明确写为数据风险或维持观察。

## 裁决建议

- display_contract 缺失、display_insights 缺失、三层缺失、key 不合法：critical failed。
- 展示文案泄漏技术字段、未证明口径词或强策略动作：major failed。
- 分层文案空泛但结构存在：major warn；若三个分层均空泛则 failed。
- 低基数/口径风险未说明：warn。
