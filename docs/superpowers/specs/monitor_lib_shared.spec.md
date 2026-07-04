# Spec · monitor_lib_shared

> **状态**：设计定稿，实施待启动
> **优先级**：P0（其他三个 spec 的地基）
> **归属**：`orchestrator/src/orchestrator/lib/monitor/`
> **作者**：Kiro
> **最后更新**：2025-07-04

---

## 一、目的

抽出机型监测与品类监测**共有的底层能力**，避免两个 skill 各写一遍。lib 只提供纯函数式工具，不涉及 workflow 编排。

**服务对象**：
- `experts/daily_analyst/skills/model_weekly_monitor/`
- `experts/daily_analyst/skills/category_weekly_monitor/`
- 未来任意"周维度漏斗监测"skill

---

## 二、能力清单

lib 只暴露 5 个函数。每个都是纯函数（输入 → 输出，无隐藏状态），便于单测。

> **⚠️ 与现有 Node 版对齐说明**：以下算法定义已修订，与 `model-tag-monitor/src/monitor.js` **严格等价**。Python 版必须与 Node 版在相同输入下产生相同输出（误差 ≤ 0.5%）。

### ① `fetch_funnel_data(dimension, week_range, source_config)`

**职责**：从飞书多维表格拉指定维度、指定周窗的漏斗原始数据。

**入参**：
- `dimension: Literal["model", "category"]`
- `week_range: tuple[str, str]` 例如 `("2025-W23", "2025-W27")`（含）
- `source_config: dict` 数据源标识（表格 token / sheet id 等）

**出参**：`list[FunnelRow]`，每行含（**与现有 cache.json 结构对齐**）：
```python
{
  "category": str,       # 品类,例:"手机"
  "modelName": str,      # 机型名,例:"iPhone 15 Pro Max 256G"
  "week": str,           # 周次,例:"2025-W27"
  "evaUv": int,          # 估价 UV(核心分母)
  "evaRate": float,      # 估价完成率
  "orderRate": float,    # 估价下单率
  "shipRate": float,     # 估价发货率
  "dealRate": float,     # 估价成交率
  "returnRate": float,   # 质检退回率
  # 可选字段:evaCount / orderCount / shipCount / dealCount / returnCount(用于校验)
}
```

**关键差异**（跟单指标 order_rate 版本对比）：
- **5 个转化率并存**，不是只看一个
- `evaUv` 是核心分母，用于 TOP N 排序和小样本过滤
- 单行 = (品类, 机型, 周) 三元组

**内部实现**：Python 重写 `sync.js` 从飞书多维表格拉数的逻辑。品类维度就是把 modelName 层聚合掉，只保留 category 层。

**失败行为**：抛 `MonitorFetchError`，含具体维度和周次。上层 workflow 决定是否重试。

---

### ② `compute_wave(rows, target_week, prev_week, rules)`

**职责**：为每个 (category, modelName) 组合算出 5 个转化率的波动 delta 与连续 N 周趋势 trend。

**入参**：
- `rows: list[FunnelRow]`
- `target_week: str` 目标周（前端筛选或本周）
- `prev_week: str | None` 上一周
- `rules: MonitorRules` 参数化配置（阈值/TOP N/趋势窗口等，见下）

**出参**：`list[WaveResult]`：
```python
{
  "category": str,
  "modelName": str,
  "cur": FunnelRow,            # target_week 那行
  "prev": FunnelRow | None,    # prev_week 那行(可能不存在)
  "delta": {                    # 5 个转化率的周环比,值域 [-1, +inf)
    "evaRate": float | None,    # (cur - prev) / prev; prev 为 0/None 时为 None
    "orderRate": float | None,
    "shipRate": float | None,
    "dealRate": float | None,
    "returnRate": float | None,
  },
  "trend": {                    # 5 个转化率的连续 N 周趋势
    "evaRate": "up" | "down" | None,   # None = 未形成连续同向
    "orderRate": "up" | "down" | None,
    "shipRate": "up" | "down" | None,
    "dealRate": "up" | "down" | None,
    "returnRate": "up" | "down" | None,
  },
}
```

**关键规则**（严格对齐 Node 版）：
- `delta` 计算：`cv is None or pv is None or pv == 0 → None`；否则 `(cv - pv) / pv`
- `trend` 计算：取 target_week 及之前的所有周，若不足 N 周直接返回 `{}`；取尾部 N 周窗口，全部严格递增 → `up`，全部严格递减 → `down`，其他 → `None`
- **不做**"flat/stable" 三段判定，Node 版没有这个概念

---

### ③ `apply_rules(wave_results, rules)`

**职责**：从 wave 结果里挑出**入池**和**关注**两组。

**入参**：
- `wave_results: list[WaveResult]`
- `rules: MonitorRules`

**MonitorRules 结构**（严格对齐 Node 版 `DEFAULT_RULES`）：
```python
{
  "poolTopN": 20,           # 每个品类取估价 UV TOP N 入池
  "poolMinWeek": None,      # None = 用最新周(Python 侧由上层 workflow 决定 target_week 后传入)
  "waveThreshold": 0.1,     # 波动阈值 ±10%
  "trendWeeks": 3,          # 连续 N 周同向
  "minEvaUv": 15,           # 分母保护:evaUv < 此值不参与波动/趋势判断
  "rates": [                # 5 个转化率的元信息
    {"key": "evaRate", "name": "估价完成率"},
    {"key": "orderRate", "name": "估价下单率"},
    {"key": "shipRate", "name": "估价发货率"},
    {"key": "dealRate", "name": "估价成交率"},
    {"key": "returnRate", "name": "质检退回率"},
  ],
}
```

**入池逻辑**（严格对齐 Node）：
1. 按 category 分组，组内按 `cur.evaUv` 降序，取前 `poolTopN` 条 → `pool`
2. `pool` 里的每条走"命中检查":
   - 若 `cur.evaUv < minEvaUv`：跳过（分母保护，不产生 flag）
   - 否则遍历 5 个转化率:
     - **波动 flag**：`delta[k]` 非 None 且 `|delta[k]| >= waveThreshold` → `{type: "wave", metric: k, name, delta}`
     - **趋势 flag**：`trend[k]` 非 None → `{type: "trend", metric: k, name, direction}`
3. 至少有一个 flag 的 pool 项进 `watch_list`

**出参**：
```python
{
  "target_week": str,
  "prev_week": str | None,
  "weeks": list[str],           # 全部可用周次(升序)
  "pool": list[WaveResult],     # 池内全量
  "watch_list": list[WaveResultWithFlags],  # 命中,附 flags 字段
  "rules": MonitorRules,        # 回传实际生效的规则(便于前端展示)
}
```

**规则可配置化**：`data/rules/model_rules.json` 存部分覆盖字段（例如 `{"waveThreshold": 0.15}`），启动时 merge 到 `DEFAULT_RULES`。业务方通过后台管理页调整该 JSON。

---

### ④ `analyze_anomaly_with_agent(watch_list, context)`

**职责**：这是 `spawn_agent` 的桩。给一批异常项，调 agent 让它给每个项一句归因假设。

**入参**：
- `watch_list: list[WaveResult]`
- `context: dict` 附加上下文（周次、维度、可参考的指标口径链接等）

**出参**：`list[AnomalyExplanation]`：
```python
{
  "dim_key": str,
  "hypothesis": str,       # AI 给的一句话归因,例:"疑似上周价格调整导致 orderRate 下滑"
  "related_metrics": list[str],  # AI 猜测相关的其他指标名
  "confidence": Literal["high", "medium", "low"],
}
```

**实现要点**：
- 用 orchestrator 的 `spawn_agent` 机制（不是 codex exec 兜底路径）
- 上下文里必须给 AI 提供 `knowledge/metrics_dictionary.md` 的相关摘录
- **超时**：单个 agent 60s，全批总超时 5 分钟
- 失败降级：agent 拿不出结果时，`hypothesis` 填 `"待人工排查"`，不阻断主流程

---

### ⑤ `push_to_feishu(payload, channel_config)`

**职责**：把整份周报（正常数据 + 异常 + AI 归因）推到飞书群。

**入参**：
- `payload: MonitorReport`（结构见下）
- `channel_config: dict`（webhook URL 或 group chat_id）

**MonitorReport 结构**：
```python
{
  "dimension": "model" | "category",
  "week": str,
  "summary": {
    "total_dims": int,
    "watch_count": int,
    "rising_count": int,
    "falling_count": int,
  },
  "top_anomalies": list[AnomalyExplanation],  # 最多 10 个
  "dashboard_url": str,                        # 前端页面链接
}
```

**推送形式**：飞书**交互式卡片**（interactive card），不是纯文本。理由：
- 支持标题 + 分栏 + 按钮
- "查看详情"按钮直接跳前端页面（带 URL 参数预填）
- 视觉更专业，适合每周固定推送

**降级路径**：如果卡片消息发送失败，降级到 `post` 富文本消息；再失败，写 `text` 消息 + 日志。

---

## 三、目录布局

```
orchestrator/src/orchestrator/lib/monitor/
├─ __init__.py
├─ schemas.py       ← FunnelRow / WaveResult / MonitorRules / MonitorResult / AnomalyExplanation / MonitorReport (Pydantic)
├─ wave.py          ← compute_wave (含 build_series / calc_delta / calc_trend)
├─ rules.py         ← apply_rules (含 DEFAULT_RULES 常量 + merge 逻辑)
├─ fetcher.py       ← fetch_funnel_data
├─ agent_hook.py    ← analyze_anomaly_with_agent
├─ pusher.py        ← push_to_feishu (调用 tools/feishu_push/)
└─ tests/
   ├─ fixtures/
   │  ├─ cache_sample.json           ← 从现有 model-tag-monitor/data/cache.json 抽的小样本
   │  └─ expected_watch_list.json    ← Node 版跑出来的标准答案
   ├─ test_wave.py                    ← 单元:calcDelta / calcTrend 边界
   ├─ test_rules.py                   ← 单元:入池 / 命中逻辑
   ├─ test_parity_with_node.py        ← 端到端:Python 输出 vs Node 输出误差 ≤ 0.5%
   └─ test_pusher_dry_run.py
```

---

## 四、跟现有代码的关系

| 现有 | 新位置 | 处理 |
|---|---|---|
| `model-tag-monitor/src/feishu.js` 读表逻辑 | `lib/monitor/fetcher.py` | Python 重写 |
| `model-tag-monitor/src/monitor.js` 算 wave + 规则 | `lib/monitor/wave.py` + `rules.py` | Python 重写，逻辑等价 |
| `model-tag-monitor/data/rules.json` | `data/rules/model_rules.json` | 位置迁移，结构不变 |
| `model-tag-monitor/data/cache.json` | 不迁，废弃 | 未来直接从飞书拉，加 60s 内存缓存 |
| Node 服务本身 | 保留 | 只作为前端静态资源 + 只读 API 层 |

**过渡期方案**：两套并行 2 周，Python 侧只跑 dry_run 校验数据一致性；一致后 Node 侧的 wave/rules 逻辑下线，Node 只留静态资源和 `/api/dashboard` 读取 Python 侧输出的 JSON。

---

## 五、验收标准

- [ ] 5 个函数全部有单测，覆盖率 ≥ 80%
- [x] **Parity 测试**：用真实生产数据（`data/real_snapshot/monitor_snapshot/raw_*.json`，10 大品类 63000+ 行，5 周窗口），Python 版 `apply_rules(compute_wave(...))` 与 Node 版 `/api/monitor?dimension=model` 输出等价：
  - `pool` 大小一致
  - `watch_list` 成员集合、`flags` 数组数量、每个 flag 的 `type` / `metric` / `direction` 完全一致
  - `delta` 数值 `|diff| < 1e-9`（不是 0.5%，是精确等值 —— 两侧都用 IEEE 754 双精度算同一份数据）

  **契约允许的差异（tie 边界）**：当 `pool` 边界（第 20 名附近）多个机型 `evaUv` 相等时，Node 版按 rows 首次出现顺序取，Python 版按 modelName 字典序取。两者选到的具体机型可能不同，但：
  - 池大小相同
  - `watch_list` 不受影响（tie 上的机型 evaUv 都在同一水平，flags 判定独立于 pool 排序）
  - 契约脚本 `scripts/verify_equivalence_real.py` 在 evaUv tie 上不判 fail，只做单独提示

  **验证脚本**：`scripts/verify_equivalence_real.py`（10/10 品类通过，见 `data/real_snapshot/EQUIVALENCE_REPORT.md`）
- [ ] `push_to_feishu` 有 dry_run 模式，`FEISHU_DRY_RUN=1` 时不真发消息，写 `data/outbox/*.json`
- [ ] `analyze_anomaly_with_agent` 支持 mock 模式，测试环境不真调 LLM
- [ ] `fetch_funnel_data` 支持 5 周窗口一次拉完，单次 < 3s
- [ ] 所有 schema 用 Pydantic，能生成 OpenAPI 文档
- [ ] `MonitorFetchError` / `MonitorPushError` 两类异常有明确层级
- [ ] `MonitorRules` 支持 JSON 部分覆盖（业务方后台调阈值场景）
- [ ] 无一处硬编码 secret / URL / chat_id

---

## 六、不做的事

- **不做前端页面渲染**：前端归 `model-tag-monitor/public/`，lib 只输出 JSON
- **不做规则的可视化编辑**：`rules.json` 手工编辑，未来另开 skill
- **不做多维度组合**（例："机型 × 品类"）：单维度先跑通
- **不做实时监控**：只做周维度批量
- **不重实现 Router 或 dispatch**：直接消费 orchestrator 现有能力

---

## 七、依赖 & 阻塞

**依赖上游**：
- orchestrator 的 `spawn_agent` 接口稳定（当前 v0.4 实施中，须确认）
- 飞书 SDK 或已有的读表封装

**阻塞下游**：
- `model_weekly_monitor.spec` 全部函数依赖此 lib
- `category_weekly_monitor.spec` 同上

**不阻塞**：
- `project_status.spec` 独立，可并行

---

## 八、开发估工

| 模块 | 估时 |
|---|---|
| schemas.py + fixtures | 0.5 天 |
| fetcher.py | 1 天（含单测） |
| wave.py + rules.py | 1 天（含单测） |
| agent_hook.py | 1 天（含 mock） |
| pusher.py + dry_run | 1 天 |
| 集成 + 数据一致性校验 | 1 天 |
| **合计** | **约 5.5 天** |
