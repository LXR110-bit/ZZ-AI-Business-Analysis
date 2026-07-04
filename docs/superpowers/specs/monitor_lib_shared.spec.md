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

### ① `fetch_funnel_data(dimension, week_range, source_config)`

**职责**：从飞书多维表格拉指定维度、指定周窗的漏斗原始数据。

**入参**：
- `dimension: Literal["model", "category"]`
- `week_range: tuple[str, str]` 例如 `("2025-W23", "2025-W27")`（含）
- `source_config: dict` 数据源标识（表格 token / sheet id 等）

**出参**：`list[FunnelRow]`，每行含：
```python
{
  "dim_key": str,        # 机型 id 或品类名
  "dim_name": str,       # 展示名
  "week": str,           # ISO 周,例 "2025-W27"
  "uv": int,
  "click": int,
  "detail_pv": int,
  "cart": int,
  "order": int,
  "gmv": float,
}
```

**内部实现**：复用现有 `model-tag-monitor/src/feishu.js` 的读表能力，但用 Python 重写，走 orchestrator 已有的飞书 SDK。

**失败行为**：抛 `MonitorFetchError`，含具体维度和周次。上层 workflow 决定是否重试。

---

### ② `compute_wave(rows, week_current, week_prev)`

**职责**：算出每个维度对象的"波动指标"。

**入参**：
- `rows: list[FunnelRow]`
- `week_current: str`, `week_prev: str`

**出参**：`list[WaveResult]`：
```python
{
  "dim_key": str,
  "dim_name": str,
  "order_rate_cur": float,   # order / uv
  "order_rate_prev": float,
  "delta_pct": float,        # (cur - prev) / prev
  "delta_dir": Literal["up", "down", "flat"],
  "gmv_cur": float,
  "gmv_prev": float,
  "trend": Literal["rising", "falling", "stable"],
}
```

**规则**：
- `flat`: `abs(delta_pct) < 0.05`（±5%）
- `rising` / `falling`: `abs(delta_pct) >= 0.15`（±15%）
- 中间地带：`up` / `down` 但 `trend = stable`

阈值全部走 `knowledge/monitor_thresholds.md`（TODO：这个文件后续加入知识库），不写死。

---

### ③ `apply_rules(wave_results, rules)`

**职责**：应用规则引擎（继承自 `model-tag-monitor/src/monitor.js` 的现有 rules.json 逻辑），把波动结果分入两组。

**入参**：
- `wave_results: list[WaveResult]`
- `rules: list[Rule]`（规则从 `data/rules/{dimension}_rules.json` 读）

**出参**：
```python
{
  "pool": list[WaveResult],       # 全池,给前端展示
  "watch_list": list[WaveResult], # 命中规则的异常,给 AI 判断和推送
}
```

**规则示例**（保持跟现有 model-tag-monitor 一致）：
```json
{
  "id": "sharp_drop",
  "condition": "delta_pct < -0.30 and gmv_prev > 10000",
  "priority": "high"
}
```

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
├─ fetcher.py       ← fetch_funnel_data
├─ wave.py          ← compute_wave
├─ rules.py         ← apply_rules
├─ agent_hook.py    ← analyze_anomaly_with_agent
├─ pusher.py        ← push_to_feishu
├─ schemas.py       ← FunnelRow / WaveResult / AnomalyExplanation / MonitorReport (Pydantic)
└─ tests/
   ├─ test_wave.py
   ├─ test_rules.py
   ├─ fixtures/     ← 假数据 JSON
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
- [ ] `compute_wave` 输出对 100 条真实机型样本，与 `model-tag-monitor/src/monitor.js` 输出误差 ≤ 0.5%
- [ ] `push_to_feishu` 有 dry_run 模式，`FEISHU_DRY_RUN=1` 时不真发消息，写 `data/outbox/*.json`
- [ ] `analyze_anomaly_with_agent` 支持 mock 模式，测试环境不真调 LLM
- [ ] `fetch_funnel_data` 支持 5 周窗口一次拉完，单次 < 3s
- [ ] 所有 schema 用 Pydantic，能生成 OpenAPI 文档
- [ ] `MonitorFetchError` / `MonitorPushError` 两类异常有明确层级
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
