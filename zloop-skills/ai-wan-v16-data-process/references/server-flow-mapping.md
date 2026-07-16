# AI 小万 v1.5.5 旧服务器流程映射

本文件定义「小万数据处理」如何复制 `model-tag-monitor` 旧服务器数据处理语义。Process 阶段不调用 LLM，不跑 SQL，只消费 Fetch 的 raw_cache。

| 旧服务器脚本/模块 | 旧行为 | 新数据处理 Skill 落点 |
| --- | --- | --- |
| `scripts/refresh-dashboard-daily.sh` | data-ready retry → coverage → WTD quality → promote → board metrics → `/api/sync*` → dashboard contract | Process 的总编排顺序；失败先写 data_quality_report，再禁止下游继续用旧缓存 |
| `scripts/validate-daily-import-coverage.js` | 校验 imports 文件、run_id、target weeks、行数、首列 `week_start_date` | `data_quality_report.raw_import_coverage` 与 `manifest_<run_dt>.json` |
| `scripts/check-wtd-quality.js` | 读取 current/baseline，按目标周比较 Top 类目、重点类目、宽范围下跌、category vs model 对账 | `data_quality_report.wtd_quality`；warn/failed 规则进入 `active_process_manifest.quality_gates` |
| `scripts/promote-local-imports.js` | staging imports 按 `week_start_date` 分区覆盖到 active imports；manifest 路径/sha256 更新 | `processed_cache/imports` 合并；同分区本次覆盖，其他分区保留 |
| `scripts/sync-board-metrics-from-feishu.js` | Feishu 大盘指标落 `board_metrics_feishu.csv` | 当前上游缺失时生成空/历史 `board-metrics.json` 并标记 known_gap；后续有快照则接入 |
| `src/sync.js` | 读取 `model_daily_avg_*.csv`，保留 `KEEP_WEEKS=10`，机型主粒度，周日均，重算 rates/avgPrice，写 `cache.json` | `server_cache_bundle/cache.json` 与 `model-cache.json`；从 detail 口径聚合出主粒度 |
| `src/category-sync.js` | 读取 `category_daily_avg_*.csv`，表头映射，`day_cnt` 周日均，taxonomy 过滤，重算 rates，写 `category-cache.json` | `server_cache_bundle/category-cache.json` |
| `src/taxonomy-sync.js` | `category_taxonomy.csv` 优先，seed 兜底，过滤 `自营(非聚合)` | `server_cache_bundle/category-taxonomy.json` 与 category rows 过滤 |
| `src/board-sync.js` | 读取 `board_metrics*.csv`，按 week 去重，保留最近 `KEEP_WEEKS=10`，写 `board-metrics.json` | `server_cache_bundle/board-metrics.json`；缺口不阻断 Process，但 warn |
| `src/tagging.js` + `server.js /api/tags*` | v1.5 标签结构 `dimensions/tags/note`，`tag-vocab.json` 定义 core/lifecycle/price/custom | `server_cache_bundle/tags.json`、`tag-vocab.json`、`tag_snapshot_manifest.json`；缺失时 fallback 默认 vocab |
| `src/compose-dashboard.js` / `/api/dashboard` | 读取 cache/category/board/tags/taxonomy 生成 dashboard contract 和 rolling 窗口 | `dashboard-source-manifest.json`、`rolling-status.json` 和 server cache bundle 解压后可复用旧展示逻辑 |

## 必须复制的关键口径

### KEEP_WEEKS=10

- 默认 `history_weeks=10`，不得退回 2 周。
- 当前周 + 上周来自 Fetch raw；更早周来自上一轮 processed cache。
- 同 grain + week + 维度 key，保留最新 `source_run_dt`。
- 裁剪后只保留最近 10 个 ISO week。
- 少于 8 周时 `history_insufficient=warn`。

### day_cnt 周日均

- `day_cnt` / `已收到天数` / `daysReceived` 映射同一字段。
- 显式日均表头（`日均`、`daily_avg`、`avg_daily`）不再除以 day_cnt。
- 非显式日均字段且 `daysReceived > 1`：指标除以 day_cnt。
- 周汇总文件保留原汇总口径，不作为 server cache 日均指标来源。

### rolling/final

- `week_start_date` 计算 ISO week。
- `endDate = startDate + 6 days`。
- `run_dt <= endDate` 且 `daysReceived < 7` 为 `rolling`。
- `daysReceived == 7` 或 `run_dt > endDate` 为 `final`。
- rolling 周每天覆盖；final 周冻结。

### 服务器展示缓存

`server_cache_bundle` 必须包含旧服务器数据目录可识别的 JSON 文件：

```text
cache.json
model-cache.json
category-cache.json
category-fulfill-cache.json
category-taxonomy.json
board-metrics.json
tags.json
tag-vocab.json
rolling-status.json
dashboard-source-manifest.json
tag_snapshot_manifest.json
```

`cache.json` 保持旧 `/api/sync` 的默认文件名；`model-cache.json` 是同内容别名，方便新链路显式识别。

### 标签快照

- 维度 key 使用 v1.5：`core`、`lifecycle`、`price`、`custom:<category>:<id>`。
- model key 使用 `category||modelName`。
- 不用 LLM 推断标签；只 normalize 已有标签或默认空。
