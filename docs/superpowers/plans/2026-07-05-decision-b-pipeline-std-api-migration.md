# 决策 B 战备方案:pipeline 换轨标准 sheets/v2 API

> **日期**: 2026-07-05  
> **性质**: **战备方案(未激活)**。当前生效防护是方案 Y(见下)。本方案仅在触发条件满足时启动。
> **上游事件**: 2026-07-04/05 sheet_ai 层持续 20h+ timeout,决策 A'' 已用标准 API 补 e2676a W27 daily(46185 行,0 tolerated)
> **当前状态**: sheet_ai 已恢复(3 次探测均 ok);生产已落地方案 Y:`run.py` 单实例锁 + `pipeline.py` 连续 tolerated batch 熔断(阈值 3,环境变量 `CSV_PUT_CONSECUTIVE_TOLERATED_ABORT` 可调)

---

## 1. 触发条件

以下**任一**满足才启动本方案实施:
- sheet_ai 层(`+csv-put/+csv-get/+dim-*/+cells-clear/+workbook-info`)持续挂 >1h
- 09:30 cron 因方案 Y 熔断连续 fail,且业务方明确要求 SLA 保障
- **不做预防性改造**(教训 6:不修没坏的东西)

## 2. 变更范围(最小)

仅换 `lark_helper.sheets_csv_put` / `sheets_csv_get` 底层为标准 `+write` / `+read`,其他函数保留:

| 函数 | 状态 | 理由 |
|---|---|---|
| `sheets_csv_put` | **改** → `+write --values` | 决策 A'' 已实证 300 行 × 16 列 68KB payload 稳定 |
| `sheets_csv_get` | **改** → `+read` + `[row=N]` 解析 | 决策 A'' 已实证一次读 5 万行 ok |
| `sheets_workbook_info` | **不改** | 若挂 → pipeline 方案 Y 熔断 fail fast,主控人工介入 |
| `sheets_dim_delete/insert` | **不改** | 同上 |
| `sheets_cells_clear` | **不改** | 同上 |

**改动面**: 1 文件(`lark_helper.py`),2 函数,~30 行。

## 3. 降级铁律

- pipeline 遇 sheet_ai 挂 → 依赖方案 Y 熔断 fail fast(已生效,不重复实现)
- 主控人工介入判断:等 sheet_ai 恢复 / 启动本方案(动 csv-put/get)
- 不 auto-fallback,避免误伤

## 4. Regression test 清单(实施前必过)

- [ ] `sheets_csv_put` 300 行 → `+read` verify 数据一致
- [ ] `sheets_csv_get` 5 万行一次读通(输出格式对齐现有 `[row=N] value` 消费方)
- [ ] 幂等:同 batch 写 2 次数据不 corrupt
- [ ] `pipeline._iter_a_col_rows` / `_csv_put_batched` 用新实现消费 → 行为不变

## 5. Tmp 表干跑(教训 6 铁律,不能省)

- 建 `sandbox_spreadsheet_token`(或复刻 5 tab 到测试 workbook)
- 跑 `run.main --months 2026-06 --target=tmp`
- 对比 tmp vs 生产表相同 offset 数据,差异 = 0 才 merge

## 6. 上线步骤(若触发)

1. 换轨改动 commit + push,**不 merge**
2. Merge 前**必须**过第 4 节 regression test +第 5 节 tmp 干跑
3. Merge PR
4. 手动跑 `run.main --skip-tabs=<已 ok 的 tab>` 单 tab 验证
5. Cron 明晨接管

## 7. 备选方案(不做,记录)

**若 sheet_ai 长期挂且 dim-* 也需要绕过**(比本方案范围更大):
- `dim-delete` 替代:`+write` 空 2D 覆盖(每 batch 300 行)
- `dim-insert` 替代:表预扩到 200000 rc(手动 UI)
- `workbook-info` 替代:`+read` 二分探测 last-data-row
- **触发**: sheet_ai 挂 >24h 且无恢复迹象
- **风险**: 新逻辑无 regression 历史,首次上生产违反教训 6,不到万不得已不做

## 8. 决策 A'' 证据参考

- `docs/evidence/2026-07-05-pipeline-recovery/`
- patch 脚本含 4-attempt retry + 100 行降级 + progress persist
- 146 batch × 300 行 116.2s 0 tolerated
- row 131936-134335 async commit 成功 = "假 timeout 报警"实证

## 9. 关联

- 教训 6: 不修没坏的东西(所以本文档是"战备"不是"立即做")
- 方案 Y(已生效): `run.py` 单实例锁 + `pipeline.py` 连续 tolerated batch 熔断
- `pipeline.py` 顶部"设计守则"3 条(csv-put/dim-delete/shrink)保持不变
