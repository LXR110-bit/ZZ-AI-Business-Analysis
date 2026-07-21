# 品类映射表契约

本契约定义 AI 小万 process 阶段如何使用飞书 Base「品类映射表」。飞书 Base 是业务修改入口，Skill 不得硬编码 192 条品类映射。

## 来源

- Wiki/Base：`https://zhuanspirit.feishu.cn/wiki/L7LowLNAbif0fgkzxIJcHCZynnb`
- Base token：`NKw4b2eKxaKhDTsOrD9cONklnGb`
- Table：`品类映射`
- 字段：
  - `三级品类`
  - `阶段`
  - `业务状态`
  - `二级板块`
  - `归类置信度`
  - `备注`

## 运行策略

1. 每次 process 运行前先读取飞书 Base 最新数据，并导出为 JSON 或 CSV。
2. 传给处理脚本：`--category-mapping-file /path/to/category_mapping.json`。
3. 飞书读取失败时，允许使用最近快照继续，快照文件名优先：
   - `category-mapping.json`
   - `category_mapping.csv`
   - `category_taxonomy.csv`
4. 使用快照时必须写入：
   - `warnings: category_mapping_feishu_read_failed_used_snapshot`
   - `known_gaps: category_mapping_source_not_realtime`
   - 下游 `display_insights.monitor` 明确“品类映射使用最近快照，非实时读取”。

## 阶段规则

- `发展`、`孵化`、`种子`：进入聚合、分析和 dashboard 三层展示。
- `自营(非聚合)`：排除聚合/万象大盘分析，不进入 `display_insights.tiers`。
- `待归类`：保留原始记录，但写入数据风险，Analyze 不能做确定性分层判断。
- `业务状态=已下线`：保留历史数据，不参与最新周环比和最新周页面判断。
- `归类置信度=待你确认`：允许保留数据，但必须进入 warnings。

## 输出

Process 必须生成 `category_mapping_manifest`：

```json
{
  "contract_version": "ai-wan-category-mapping/v1",
  "source": {
    "type": "feishu_base_mapping_file|feishu_base_mapping_snapshot_json|feishu_base_mapping_snapshot_csv|previous_processed_category_mapping_snapshot",
    "base_token": "NKw4b2eKxaKhDTsOrD9cONklnGb",
    "table": "品类映射",
    "sha256": ""
  },
  "record_count": 192,
  "stats": {
    "categories_in_data": 0,
    "unmatched_categories": 0,
    "pending_categories": 0,
    "offline_categories": 0,
    "self_operated_non_aggregate": 0,
    "tiers": {
      "发展": 0,
      "孵化": 0,
      "种子": 0,
      "自营(非聚合)": 0,
      "待归类": 0
    }
  },
  "unmatched_categories": [],
  "pending_categories": [],
  "offline_categories": [],
  "self_operated_categories": []
}
```

`category_mapping_manifest` 必须同时进入 `active_process_manifest`、`data_quality_report` 和 `server_cache_bundle/cache/category-mapping-manifest.json`。
