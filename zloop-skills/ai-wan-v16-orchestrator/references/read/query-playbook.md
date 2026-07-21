# AI 小万 v1.5.5 Fetch SQL Playbook

## 业务与执行方式

- 业务：聚合回收
- business_code：`d_c2b_union`
- 数据源：Hive / 星河
- 执行方式：委托 `xinghe-data-explore` 执行，不自带数据库直连。
- LLM：禁止调用任何 LLM。
- 当前 Fetch 范围：固化 7 份 SQL 的 raw 取数；Loop1 基础范围包含 4 份品类 SQL 和 `sqldau`，APP DAU/回收入口 UV 不再读取飞书静态快照。

## 参数约定

7 份 SQL 中存在不同占位符，执行前需统一替换：

| 历史占位符 | 含义 | 建议值 |
| --- | --- | --- |
| `${outFileSuffix}` | 模板历史变量名，语义是“数据日/昨日”（不是本次执行日今天） | `data_end_date`，格式 `YYYY-MM-DD` |
| `${hiveconf:end_date}` | 查询窗口结束日期 | `data_end_date` |
| `${hiveconf:run_dt}` | 兼容旧模板的运行/查询日期变量；Loop1 不用它决定订单分区 | `run_dt` |
| `$bash{date +%Y-%m-%d -d '-1 day'}` | 历史 shell 写法，语义是订单全量表 T-1 分区，不是在沙箱里执行 `date` | `data_end_date` |
| `${#date(0,0,-1):yyyy-MM-dd#}` | 平台日期宏，历史表示昨日/数据日 | `data_end_date` |

默认窗口逻辑沿用 SQL：以 `run_dt` 所在自然周及上一自然周为主，周起始按 SQL 中 `date_sub(... '2018-01-01' ...)` 的周一口径计算。是否合入近 10 周历史由 Process 阶段完成。

### 模板日期语义（给 zloop agent 的硬约束）

这些 SQL 是离线模板，不是让 agent 在沙箱里解释/改写的自然语言脚本：

- `run_dt` = 本次 Loop 执行日期（Asia/Shanghai 今天）。
- `data_end_date` = 数据截止日，即 `run_dt - 1 day`，也是订单全量表的 T-1 分区日。
- `${outFileSuffix}` 虽然名字像“输出后缀”，但模板注释里写的是“代表昨日”，在 Loop1 中必须按 `data_end_date` 注入。
- `$bash{date +%Y-%m-%d -d '-1 day'}` 是历史模板占位符，表示 T-1 分区；agent 不得把它当作沙箱本地 shell 的实时日期，也不得改成 `max(dt)` 或执行日当天。
- 所有订单链路 SQL 仍严格使用 `t0.dt = data_end_date`；如果早跑撞未就绪数据，靠 `DATA_INTEGRITY_ORDER_CHAIN_EMPTY` 数据门/缓存复用校验拦截，不改 SQL 口径。

## SQL 与 raw 文件

| 编号 | SQL 文件 | raw CSV | 粒度 | Fetch 说明 |
| --- | --- | --- | --- | --- |
| 1 | `references/read/sql/category_daily_avg.sql` | `raw/category_daily_avg_<run_dt>.csv` | 周 × 品类 | 原始周日均取数，通常含 `day_cnt` |
| 2 | `references/read/sql/category_summary.sql` | `raw/category_summary_<run_dt>.csv` | 周 × 品类 | 原始周汇总取数 |
| 3 | `references/read/sql/category_fulfill_daily_avg.sql` | `raw/category_fulfill_daily_avg_<run_dt>.csv` | 周 × 品类 × 履约方式 | 原始履约周日均取数，通常含 `day_cnt` |
| 4 | `references/read/sql/category_fulfill_summary.sql` | `raw/category_fulfill_summary_<run_dt>.csv` | 周 × 品类 × 履约方式 | 原始履约周汇总取数 |
| 5 | `references/read/sql/sqldau.sql` | `raw/sqldau_<run_dt>.csv` | 周 | APP DAU 与回收入口 UV 周日均；输出 `week_start_date/day_cnt/avg_dau/avg_recycle_entrance_uv` |
| 6 | `references/read/sql/model_daily_avg.sql` | `raw/model_daily_avg_<run_dt>.csv` | 周 × 品类 × 机型 × 可选属性/成色/履约 | 原始机型取数；Sheet5 最细粒度由 Process 校验/提取 |
| 7 | `references/read/sql/model_summary.sql` | `raw/model_summary_<run_dt>.csv` | 周 × 品类 × 机型 × 可选属性/成色/履约 | 原始机型周汇总取数 |

## 沙箱调度策略

zloop 沙箱磁盘与执行窗口有限，Fetch 禁止一次性提交 7 个 SQL。必须按受控并发调度：

```text
重 SQL 队列，并发 1：
1. model_daily_avg
2. model_summary

轻 SQL 队列，并发 2：
1. category_daily_avg
2. category_summary
3. category_fulfill_daily_avg
4. category_fulfill_summary
5. sqldau

总并发最多 3。
```

同一 `run_dt + rendered_sql_sha256` 下，已成功并落成 CSV 的 SQL 可以断点复用；复用前必须校验 CSV 存在、bytes > 0、行数可读取、sha256 可记录。`run_dt` 或 SQL hash 变化时禁止复用。

失败时只保留极简诊断 JSON 和可复用状态，不保留 raw CSV、raw_cache、debug 下载文件等中间大文件。validate 写服务器成功后也必须清理 read/process 大文件。

## 固定过滤口径

Fetch 不改写 SQL 业务过滤；以下口径必须保留在 SQL 中：

- 聚合品类过滤：通过 `raw_manual_c2b_category_classify` 的 `cate_type = '聚合品类'` 约束。
- 下单及之后的线上履约来源：`2701017`、`2701034`、`2701035`、`2706006`。
- 部分 SQL 可保留 `2705008`、`2705014`、`2705013` 作为中间订单来源，但最终输出履约方式只取上述线上流程口径。
- 机型 SQL 使用 `hdp_ubu_zhuanzhuan_tmp_c2b.tmp_c2b_union_model_slice_inc_1d`。
- 品类 SQL 使用估价、机况选择和订单明细相关表聚合。
- `sqldau` 固定读取 `ads_bi_recycle_traffic_order_overview_inc_1d`，并保留 `platform/terminal/perform/cate/business_line/is_tradein/cate_type/brand = all` 的全大盘口径。

## raw 文件完整性检查

Fetch 只做文件级检查：

- CSV 文件存在且 bytes > 0；
- 可读取表头；
- 记录 `source_headers`、`row_count`、`column_count`；
- 计算每个 CSV sha256 和 raw_cache zip sha256；
- 记录每个 SQL 的 `execute_id`、开始/结束时间、状态、错误摘要。

Fetch **不得**执行以下处理：

- 不把英文字段名转成 dashboard 中文表头；
- 不修复字段内逗号；
- 不提取 / 合并 model Sheet5；
- 不除以 `day_cnt`；
- 不计算 ISO week、`startDate`、`endDate`、rolling/final；
- 不读取标签快照或服务器缓存；
- 不生成 Excel / imports zip / server cache bundle。

## raw_cache 产物

默认全量执行时必须生成：

```text
raw_cache_<run_dt>.zip
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
active_fetch_manifest.json
```

`raw_cache_<run_dt>.zip` 包含：

```text
raw/*.csv
sql/*.sql
sql_status_<run_dt>.json
raw_manifest_<run_dt>.json
```

产物需保存到 zloop 云盘/文件区或 Loop 可读的持久位置；返回结果中最多展示 run_id、run_dt、每个 SQL 的 execute_id/状态/行数、raw_cache 链接或路径、active_fetch_manifest 链接或路径。

## 失败与重跑

- 任一 SQL 非 SUCCESS 时，`active_fetch_manifest.status=failed`。
- 失败 manifest 必须写出本次失败原因，不得指向旧成功 raw_cache。
- Process 仅允许消费同一 `run_dt` 且 `status=success` 的 active_fetch_manifest。
