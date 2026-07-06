# model-tag-monitor 2.0 改造设计

**日期**：2026-07-06
**分支**：`feature/dashboard-drilldown`（PR #12，仓库 `ZZ-AI-Business-Analysis`）
**项目路径**：`model-tag-monitor/`（生产环境：`zz-server:/root/model-tag-monitor/`，端口 8848）
**上一版交接文档**：`model-tag-monitor/HANDOFF_v2.md`

## 背景

v1.0（概览页 4 张 KPI 卡 + GMV 趋势 + 异常品类环形图 + Top10 异常机型 + 下钻链路）已在生产运行。2.0 改造把概览页整体重写为"大盘 → 发展/孵化/种子 → 品类 → 机型"总分总四层结构，同时接入新的品类级数据源和品类分层映射。

前置核对（2026-07-06）：生产代码（`src/*.js`、`public/*`）与仓库 HEAD `28bf9e5` 逐字节 diff 一致，无漂移，可以放心在此基础上开发。

## 现状基线（v1.0，不在本次改造范围内的部分）

- 机型层数据：`data/cache.json`，字段含 `jkuv`（机况UV）、`evaUv`（估价UV）、`evaCnt`、`orderUv`（下单UV）、`orderCnt`、`shipCnt`、`signCnt`、`qcCnt`、`dealCnt`（成交量）、`returnCnt`、`gmv`，派生比率 `evaRate=evaUv/jkuv`、`orderRate=orderUv/evaUv`、`shipRate=shipCnt/evaUv`、`dealRate=dealCnt/evaUv`（`src/sync.js`）
- 机型层监测核心逻辑：`src/monitor.js`，输出 `pool`/`watchList`，本次改造**只读不改**
- Top10 面板两处业务规则（2026-07-05 刚修复，2.0 必须保留）：
  1. 排序数据源用 `watchList` 不用 `pool`，避免估价 UV 个位数机型算出虚高倍数
  2. 追加 `.filter((row) => row.gmv > 0)`，排除本周零成交机型
- 前端零框架依赖，`public/app.js`（1124行）承载全部前端逻辑
- 老监测/规则/标签页现有逻辑不受影响，改动走增量

## 不属于本次改造范围（明确排除，避免混淆）

- PR #39（`feat(skills): add base migration flow`）是"机型周数据"上游 workflow 把飞书 Sheets 写入迁移到多维表格（Base）的独立工作，与 model-tag-monitor 的读取端完全独立。**除非未来团队决定彻底停用老 Sheets，否则 `src/sync.js`/`src/feishu.js` 的机型层读取逻辑不需要跟着这次迁移改动。**
- README.md 里记录的 Obj token（`TzkVs1LVshLaZjtH1nzcG4opnxb`）与 `src/sync.js` 实际读取的表（`UzEZwrOTVimV0RkjOaBcT4EWnGf`）不一致——这是文档过期问题，本次改造顺手更新 README，不涉及代码逻辑变更。
- 不引入前端框架；不改端口/域名/pm2 配置；不动飞书同步机制本身的架构、规则引擎、标签系统。

## 品类分层映射（数据来源与口径）

来源：`/Users/lilixiaoran/工作/转转/ai数据分析工作流/品类映射表.xlsx`（用户维护的最终版本），Sheet `品类映射`，列结构：

| 三级品类 | 阶段 | 二级板块 | 业务状态 | 归类置信度 | 最新周GMV(元) | 备注 |
|---|---|---|---|---|---|---|

- **阶段**（`tier`）四选一：`发展`（28个，精细化运营基本盘，GMV占90%/订单占79%）/ `孵化`（12个，0→1开拓，H2独立KPI不背GMV/订单）/ `种子`（回收范围内覆盖+承接+观察，非运营重点）/ `自营(非聚合)`（转转自营，不属于聚合/万象业务范围）
- **业务状态**（`status`）：`在售` / `已下线`。已下线品类分析代码要跳过当周环比，但保留历史数据可查
- **三级品类**列对应现有 `category-cache.json` 里的 `category` 字段值，是 join key，不做映射转换
- 顶层"发展/孵化"展示层最终定为**发展/孵化/种子三层平行展示**（种子不做运营重点但仍展示，便于观察）
- **`自营(非聚合)`品类在数据源头直接过滤**，不进入 `category-cache.json` 和 `category-taxonomy.json`，因此大盘层聚合时不需要额外排除逻辑

映射表同步链路：用户在本机维护 Excel → 上传到飞书 Base（新建专用多维表格）→ backend-agent 新增定时同步任务（参考现有 `src/sync.js` 模式）定期拉取落地为 `data/category-taxonomy.json`。

## 三 agent 并行分工

三方职责边界清晰、产出边界即为契约边界，唯一同步点是下面的数据契约。三方先吃 mock 数据独立开发，互不阻塞；契约冻结后如某方发现真实数据跟契约有偏差，走契约变更流程（找总控对齐，不擅自改字段含义）。

- **backend-agent**（后端数据导入处理）：接入品类级数据源（去重口径与机型级不同，是独立数据源，不能从机型级简单汇总得到）；新增品类映射表定时同步任务；产出契约文件 `category-cache.json`、`category-taxonomy.json`；在数据源头过滤掉 `自营(非聚合)` 品类
- **analysis-agent**（数据分析层）：实现大盘/发展孵化种子/品类三层的聚合与转化率逻辑，机型层复用现有 `monitor.js`（只读）；消费 backend-agent 产出的契约文件；已下线品类环比跳过逻辑
- **frontend-agent**（前端展示层）：重写概览页为四层总分总布局及层间下钻交互；消费 analysis-agent 产出的聚合结果契约
- **总控（我）**：维护数据契约、协调三方对齐、做集成回归和对抗性 code review

## 数据契约

### `data/category-cache.json`（backend-agent 产出，已排除自营非聚合）

```json
{
  "syncedAt": "ISO时间",
  "source": { "wikiNode": "...", "objToken": "..." },
  "rows": [
    {
      "week": "2026-W27",
      "category": "无人机",
      "jkuv": 0, "evaUv": 0, "evaCnt": 0, "orderUv": 0, "orderCnt": 0,
      "shipCnt": 0, "signCnt": 0, "qcCnt": 0, "dealCnt": 0, "returnCnt": 0, "gmv": 0,
      "evaRate": 0, "orderRate": 0, "shipRate": 0, "dealRate": 0
    }
  ]
}
```

字段命名和派生比率公式沿用 `src/sync.js` 现有约定。

### `data/category-taxonomy.json`（backend-agent 产出，定时从飞书 Base 拉取，已排除自营非聚合）

```json
{
  "syncedAt": "ISO时间",
  "rows": [
    { "category": "运动相机", "tier": "发展", "board": "摄影摄像", "status": "在售", "confidence": "高", "lastWeekGmv": 586271 }
  ]
}
```

`tier` 取值范围：`发展` / `孵化` / `种子`（`自营(非聚合)` 已在源头过滤，不会出现在此文件中）。

两份数据以 `category` 字段为 join key。

## 四层聚合逻辑（analysis-agent）

- **机型层**：不变，直接读 `monitor.js` 的 `pool`/`watchList`
- **品类层**：`category-cache.json` 本身即品类粒度，直接使用，不需要聚合
- **发展/孵化/种子层**：按 `category-taxonomy.json` 的 `tier` 分组，对品类层数据求和
- **大盘层**：发展+孵化+种子三层之和（自营已在数据源头排除，无需额外排除逻辑）
- **已下线品类**：`status=已下线` 的品类保留历史数据可查，但当周环比（delta）计算时跳过，不计入环比对比，避免 0 值拉低整体环比数字

四层共享同一套转化率公式（机况UV→估价UV→下单UV→成交量→GMV），保证上下钻取口径一致。

## 前端总分总结构（frontend-agent）

概览页从上到下：大盘漏斗趋势 → 发展/孵化/种子三层对比 → 品类维度列表 → 机型维度 Top10（保留现有两条 bugfix 规则）。

- 大盘/发展孵化种子/品类三层都是概览页内的视角切换（点击某层筛选下一层展示范围），不跳转页面
- 只有点击具体机型才沿用 v1.0 现有下钻链路跳转监测页，复用现有单品类 URL 参数（`tab/view/week/category/trend/highlight/from`），不需要给监测页新增多品类筛选能力

`src/dashboard.js`（423行）整体重写，拆分成按层的独立模块（如 `funnel.js`/`category.js`/`tier.js`），便于三方各自负责部分独立测试，避免继续堆到单文件。

## 测试策略

**各层自测**（各 agent 任务范围内）：
- backend-agent：mock schema 校验 + 真实数据接入后跑 diff 校验字段无漂移；已下线品类"保留历史不参环比"专项测试
- analysis-agent：单测覆盖四层聚合、转化率计算、已下线品类环比跳过逻辑（仿照现有 `compose-dashboard.test.js` 模式）
- frontend-agent：mock 契约数据跑通四层渲染+下钻交互，浏览器验证

**集成回归**（总控负责）：三方产出汇合后，校验实际产出是否符合契约（字段名、类型、`tier` 取值范围），跑 `npm test` 全量回归，确认监测/规则/标签页不受影响。

**对抗性 review**（总控负责，独立于实现视角）：重点检查契约边界是否被悄悄破坏（如某方为图方便直接改了另一层字段含义）、已下线/自营品类过滤逻辑是否被绕过、四层转化率口径是否真正一致。使用 `code-review` skill 跑一遍，再自行过一遍逐层数据流。

## 部署与运维约束（沿用 v1.0）

- 改代码前先从生产机现场拉取最新文件核对，不信任本地"副本"路径
- 改完部署后必须同步回 git 仓库（commit + push 到 `feature/dashboard-drilldown`）
- 验证时做逐字节 diff，不能只看"测试通过"就认为一致
- 部署方式沿用 `rsync` + `pm2 reload`，不改端口/域名/pm2 配置
