# 机型周数据 Base 迁移实现说明

## 背景

生产 `机型周数据` pipeline 在飞书 Sheets 大表上反复卡在 `dim-insert`、`csv-put`、A 列扫描和结构校验阶段。Base 迁移的目标是将大批量写入从单元格 range API 改为文件导入型记录存储，保留旧 Sheets 作为回滚链路。

## 本 PR 的行为

- 将当前生产 workflow 的必要源码纳入 git 管理，排除 `.bak`、日志和真实数据快照。
- 新增 `--base-migration` 模式，默认只生成迁移包，不写 Base。
- 只有显式传 `--base-import` 且非 `--dry-run` 时，才调用 `drive +import --type bitable` 并发布 `周索引`。
- 迁移包路径：`/tmp/机型周数据_base_migration/<week>/<run_id>/`。
- 每次导入都是新版本，`周索引.active=true` 的版本才是下游可用版本。

## 推荐命令

```bash
# 只生成 W27 迁移包，不写飞书
python3 -m skills.workflows.机型周数据 --base-migration --months 2026-06 --lookback-days 14 --dry-run

# 生成并导入 Base（显式写操作）
python3 -m skills.workflows.机型周数据 --base-migration --base-import --months 2026-06 --lookback-days 14 --base-as user
```

## 防重复规则

同一统计周重复导入时，不覆盖旧版本。导入校验成功后，发布逻辑会将同一批 Base 表名的旧 active 记录归档，并写入新 run_id 的 active 索引记录。下游必须以 `周索引.active=true` 为唯一入口。
