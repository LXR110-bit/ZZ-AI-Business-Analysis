# 数据 → 前端 数据契约 v1

> 面向:前端 Agent(页面交互 UI 优化)、主控 Agent
> 来源:`orchestrator/src/orchestrator/lib/monitor/schemas.py`
> 分支:`feature/monitor-lib-shared`
> 版本:2025-07-04 · v1(草案,待前端 agent 确认后 v1.0)

---

## 一、TL;DR

数据 Agent 产出的核心业务对象叫 **`MonitorResult`**,是一次周报运行的完整结果。字段命名**全部沿用 Node 版 camelCase**(modelName / evaUv / orderRate),前端可以直接消费,零转换成本。

**建议的交付方式**(欢迎前端 agent 提反案):
- 数据 Agent 把每次运行结果写到 `data/monitor_output/{dimension}_{week}.json`
- 前端从磁盘直接读,或者数据 Agent 加一个 orchestrator 的 GET 端点
- 具体走哪种,看前端框架栈决定

---

## 二、核心结构:MonitorResult

```jsonc
{
  "targetWeek": "2025-W27",           // 本次监测的目标周
  "prevWeek": "2025-W26",             // 上一周(可能为 null,如首周)
  "weeks": ["2025-W23", ..., "2025-W27"],  // 全部可用周次(升序,给筛选器用)

  "pool": [WaveResult, ...],           // 池内全量,给前端渲染列表
  "watchList": [WaveResultWithFlags, ...],  // 命中项,给前端高亮/排序
  "rules": MonitorRules                // 当次生效的规则参数(可展示在页面)
}
```

## 三、WaveResult:单个机型/品类的完整状态

```jsonc
{
  "category": "手机",
  "modelName": "iPhone 15 Pro Max 256G",
  "tags": ["高价值", "旗舰"],           // 从标签系统带过来,可能为空

  "cur": {                              // target_week 那一行原始数据
    "category": "手机",
    "modelName": "iPhone 15 Pro Max 256G",
    "week": "2025-W27",
    "evaUv": 1200,                     // 估价 UV,核心分母
    "evaRate": 0.235,                  // 估价完成率
    "orderRate": 0.121,                // 估价下单率
    "shipRate": 0.94,                  // 估价发货率
    "dealRate": 0.89,                  // 估价成交率
    "returnRate": 0.03                 // 质检退回率
  },
  "prev": { ... 同 cur 结构, week=prevWeek },  // 可能为 null

  "delta": {                            // 5 个转化率的周环比 (cur-prev)/prev
    "evaRate": 0.0217,                 // +2.17%
    "orderRate": -0.3424,              // -34.24%(大幅下滑)
    "shipRate": 0.0108,
    "dealRate": 0.0114,
    "returnRate": 0.0                  // 或 null(分母 0 / 缺数据)
  },

  "trend": {                            // 5 个转化率的连续 N 周严格同向
    "evaRate": "up",                   // "up" | "down" | null
    "orderRate": null,                 // null = 未形成连续同向
    "shipRate": "up",
    "dealRate": "up",
    "returnRate": null
  }
}
```

**给前端的建议展示逻辑**:
- 5 个转化率各占一列,`delta` 值决定颜色(正值绿 / 负值红,|value| 越大颜色越深)
- `trend.up` 加个 ↑ 图标,`trend.down` 加 ↓
- `cur.evaUv` 用于列表默认排序(降序)

## 四、WaveResultWithFlags:命中项

跟 WaveResult 完全一样,多一个 `flags` 数组:

```jsonc
{
  ...(所有 WaveResult 字段),
  "flags": [
    {
      "type": "wave",                  // "wave" | "trend"
      "metric": "orderRate",           // 5 个转化率之一
      "name": "估价下单率",             // 中文展示名
      "delta": -0.3424,                // 波动 flag 独有;趋势 flag 为 null
      "direction": null                // 趋势 flag 独有;波动 flag 为 null
    },
    {
      "type": "trend",
      "metric": "evaRate",
      "name": "估价完成率",
      "delta": null,
      "direction": "up"
    }
  ]
}
```

**给前端的建议展示逻辑**:
- 每个 flag 渲染成一枚标签徽章(wave 用波纹图标,trend 用箭头图标)
- watchList 独立成一个 tab / 板块,置顶展示,和 pool 区分
- 一个机型可能同时有多个 flag(比如 5 个转化率里 3 个都超阈值)

## 五、MonitorRules:当次生效的规则

```jsonc
{
  "poolTopN": 20,                      // 每个品类取 UV TOP N 入池
  "poolMinWeek": null,                 // null = 用最新周(前端不用管这个字段)
  "waveThreshold": 0.1,                // 波动阈值 ±10%
  "trendWeeks": 3,                     // 连续 N 周同向
  "minEvaUv": 15,                      // 分母保护 · 全局兜底(三级 fallback 优先级 3)
  "minEvaUvPct": null,                 // 分母保护 · 品类占比(优先级 2);null=不启用
  "perCategoryMinEvaUv": {},           // 分母保护 · 分品类白名单(优先级 1);key=category_name
  "rates": [                           // 5 个转化率的元信息
    {"key": "evaRate", "name": "估价完成率"},
    {"key": "orderRate", "name": "估价下单率"},
    {"key": "shipRate", "name": "估价发货率"},
    {"key": "dealRate", "name": "估价成交率"},
    {"key": "returnRate", "name": "质检退回率"}
  ]
}
```

**用途**:页面顶部展示"当前监测规则 · 波动阈值 10% · 连续 3 周同向 · TOP 20"这样的说明,让运营看得懂"为什么这个机型入了 watchList"。

### 5.1 三级 fallback 分母保护(spec monitor_noise_reduction 阶段 2 引入)

**新加两字段** `minEvaUvPct` 和 `perCategoryMinEvaUv`,与原有 `minEvaUv` 组成**三级 fallback**:

| 优先级 | 字段 | 语义 | 缺失时行为 |
|---|---|---|---|
| 1 | `perCategoryMinEvaUv[category]` | 该品类的绝对阈值(业务方白名单) | 降级到 2 |
| 2 | `cat_total_evauv * minEvaUvPct` | 该品类当周总 evaUv × 占比阈值 | 降级到 3 |
| 3 | `minEvaUv` | 全局兜底(与升级前行为完全等同) | — |

**向后兼容承诺**:两字段全 falsy 默认(`{}` / `null`),老 `rules.json` 升级后行为 **完全等同当前** — 前端无需任何改动。

**前端可选展示**(P2 优先级,不阻塞本 PR):
- 若 `perCategoryMinEvaUv` 非空,可在"当前监测规则"横条加一行"品类白名单:手机(500) · 台球杆(200)"
- 若 `minEvaUvPct` 非空,可展示"品类占比过滤:≥2%"

## 六、字段命名约定

| 侧 | 约定 |
|---|---|
| 数据 Agent 内部(Python) | Pydantic model 属性也用 `camelCase`(与 Node cache.json 一致) |
| 磁盘 JSON / API 传输 | 全 `camelCase` |
| 前端 TypeScript 类型 | 建议 `camelCase`,零转换 |

**不引入 snake_case**,避免两侧翻译成本。

## 七、待前端 Agent 确认的点

- [ ] 认可以上契约,或提出字段/命名/形态改动
- [ ] 交付方式偏好:**磁盘 JSON 文件**(简单)还是 **HTTP 端点**(动态)?
- [ ] 是否需要分页 / 增量?当前设计是一次给全量 pool
- [ ] `weeks` 数组:期望多长的历史窗口?现在默认全部
- [ ] `dashboard-drilldown` 分支上现有页面复用还是新做?

## 八、数据 Agent 侧的兑现节奏

| 阶段 | 交付物 | 状态 |
|---|---|---|
| ✅ 核心算法 | schemas + wave + rules + 单测 + Node 等价性验证 | 已完成(commit `a1fc053`) |
| 🚧 Mock 端到端 | fetcher(mock) + agent_hook(mock) + pusher(dry_run) | 进行中,今日交付 |
| ⏳ 磁盘输出 | `data/monitor_output/{model|category}_{week}.json` | mock 完成后自然带出 |
| ⏳ 真实数据 | fetcher 接飞书表格,agent_hook 接 spawn_agent | 阻塞:表格 token / spawn_agent 用法 |
| ⏳ API 层(可选) | orchestrator 新增 `GET /monitor/{dimension}/{week}` | 阻塞:前端偏好确认 |

## 九、示例:一次真实运行输出片段

我用 fixture 跑了一遍(target_week=2025-W27),watchList 3 条命中:

```jsonc
{
  "targetWeek": "2025-W27",
  "prevWeek": "2025-W26",
  "weeks": ["2025-W23", "2025-W24", "2025-W25", "2025-W26", "2025-W27"],
  "watchList": [
    {
      "category": "手机",
      "modelName": "iPhone 15 Pro Max 256G",
      "cur": {"evaUv": 1200, "orderRate": 0.121, ...},
      "prev": {"evaUv": 1150, "orderRate": 0.184, ...},
      "delta": {"orderRate": -0.3424, "evaRate": 0.0217, ...},
      "trend": {"evaRate": "up", ...},
      "flags": [
        {"type": "wave", "metric": "orderRate", "name": "估价下单率", "delta": -0.3424},
        {"type": "trend", "metric": "evaRate", "name": "估价完成率", "direction": "up"}
      ]
    },
    // ... 华为 Mate 60、Redmi K70 等
  ]
}
```

**这一版契约 v1 待前端 Agent 或主控 Agent 反馈后固化为 v1.0。**
