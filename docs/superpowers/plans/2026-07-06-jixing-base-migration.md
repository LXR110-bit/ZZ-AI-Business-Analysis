# 机型周数据 Base 迁移实现说明

## 背景

生产 `机型周数据` pipeline 在飞书 Sheets 大表上反复卡在 `dim-insert`、`csv-put`、A 列扫描和结构校验阶段。Base 迁移的目标是将大批量写入从单元格 range API 改为文件导入型记录存储，保留旧 Sheets 作为回滚链路。

## 本 PR 的行为

- 将当前生产 workflow 的必要源码纳入 git 管理，排除 `.bak`、日志和真实数据快照。
- 新增 `--base-migration` 模式，默认只生成迁移包，不写 Base。
- 只有显式传 `--base-import` 且非 `--dry-run` 时，才调用 `drive +import --type bitable` 并发布 `周索引`。
- 迁移包路径：`/tmp/机型周数据_base_migration/<week>/<run_id>/`。
- 每次导入都是新版本，`周索引.active=true` 的版本才是下游可用版本。
- 支持用户预先建好的 Base 目标映射：`skills/workflows/机型周数据/base_targets.json`。
  - 当前 workflow 使用 `family=model`，即机型维度。
  - `--base-import-mode auto` 在未显式传 `--base-token` 时会优先把汇总/日均拆成两个导入包，分别导入用户提供的 Base。
  - 若目标映射缺失，导入会 fail fast，不会自动创建错误的新 Base。

## 推荐命令

```bash
# 只生成 W27 迁移包，不写飞书
python3 -m skills.workflows.机型周数据 --base-migration --months 2026-06 --lookback-days 14 --dry-run

# 生成并导入用户已建 Base（显式写操作；auto 会使用 base_targets.json）
python3 -m skills.workflows.机型周数据 --base-migration --base-import --months 2026-06 --lookback-days 14 --base-as user --base-import-mode mapped --base-target-family model

# 若要回到旧方案：一个月一个 Base（不使用用户已建目标映射）
python3 -m skills.workflows.机型周数据 --base-migration --base-import --months 2026-06 --lookback-days 14 --base-as user --base-import-mode monthly --base-token <base_token>
```

## 用户已建 Base 映射检查

- 2026-04/05/06/07 机型维度：汇总、日均目标均已登记；历史完整周回刷按周一所在月拆分，W18→4月、W19-W22→5月、W23-W27→6月、W28起→7月。
- 2026-04/05/06/07 品类维度：汇总、日均目标均已登记；本次品类 SQL 只覆盖 Sheet1 品类维度和 Sheet4 履约维度。
- 用户已确认「大盘维度日均5月」修正链接；使用 Base 内真实可用表 `tblivmx4h0pTZGcK`。
- 这些 Base 当前基本还是默认空表（一张 `数据表`，一个 `文本` 字段）。大批量初始化仍走 `drive +import --type bitable`，导入会在目标 Base 内新建本次 run 的数据表；不会用 record API 逐行灌入默认表。

## 防重复规则

同一统计周重复导入时，不覆盖旧版本。导入校验成功后，发布逻辑会将同一批 Base 表名的旧 active 记录归档，并写入新 run_id 的 active 索引记录。下游必须以 `周索引.active=true` 为唯一入口。
