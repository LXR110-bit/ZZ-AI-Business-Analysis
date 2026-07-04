# Spec · model_weekly_monitor

> **状态**：设计定稿，实施待启动
> **优先级**：P1（依赖 monitor_lib_shared）
> **归属**：`experts/daily_analyst/skills/model_weekly_monitor/`
> **触发**：cron 每周一 09:00 自动 + 飞书 @ 机器人手动
> **作者**：Kiro
> **最后更新**：2025-07-04

---

## 一、目的

把现有 `model-tag-monitor` 项目的核心业务能力（机型周维度监测）**沉淀为 daily_analyst 的一个 skill**，让 Router 能路由到它，让 workflow 引擎每周自动跑一遍，让 spawn_agent 判断异常项的归因，让飞书群收到带 AI 分析的周报。

**核心场景**：
- 每周一 09:00 自动出机型监测周报，推飞书群
- 用户飞书 @ 机器人"本周机型监测"可即时重跑
- 报告含 AI 归因："iPhone 15 Pro Max orderRate 环比 -35%，疑似上周官方降价导致"

---

## 二、Skill 元数据

```yaml
---
name: model_weekly_monitor
type: workflow
version: 1.0
owner: daily_analyst
description: 机型维度周监测,输出漏斗波动 + AI 归因 + 飞书推送
triggers:
  - cron: "0 9 * * 1"       # 每周一 09:00 (LOCAL)
  - keywords:               # Router 匹配
      - "机型监测"
      - "机型周报"
      - "本周机型"
      - "机型波动"
inputs:
  week: str | null          # 默认 ISO 上一完整周
  dry_run: bool = false
  push_channel: str | null  # 默认从 config 读
outputs:
  report_url: str           # 飞书文档链接
  dashboard_url: str        # 前端页面链接
  anomaly_count: int
  execution_id: str
---
```

**触发路径**：
1. Cron → orchestrator scheduler → workflow runner
2. 飞书消息 → Router → planner 选中该 skill → dispatch 走 workflow 路径

---

## 三、Workflow 步骤

```
[start]
  ↓
① resolve_week (输入 week=null 时算出上一完整 ISO 周)
  ↓
② fetch_funnel_data (dimension="model", 拉本周 + 上周 = 2 周)
  ↓
③ compute_wave
  ↓
④ apply_rules (读 data/rules/model_rules.json)
  ↓ ↓
  │ └→ [pool] 全池数据,写文件 data/reports/model_pool_{week}.json
  ↓
⑤ 判断 watch_list 数量:
    - 0 个 → 跳到 ⑦,只推 "本周无异常" 简讯
    - ≥ 1 个 → 继续 ⑥
  ↓
⑥ spawn_agent × N (analyze_anomaly_with_agent, 并发上限 5)
  ↓
⑦ build_report (拼装 MonitorReport,含前端 dashboard_url)
  ↓
⑧ write_report_doc (推飞书云文档,拿到 report_url)
  ↓
⑨ push_to_feishu (交互式卡片,带 "查看详情" 按钮)
  ↓
⑩ persist_execution_log (data/executions/model_{week}_{ts}.json)
  ↓
[end] 返回 {report_url, dashboard_url, anomaly_count, execution_id}
```

**关键错误处理**：
- 步骤 ② 失败：重试 3 次，仍失败则推飞书失败提醒 + 抛异常，不 fallback 走 codex exec
- 步骤 ⑥ 部分失败：允许，失败项的 hypothesis 填 "待人工排查"，继续 ⑦
- 步骤 ⑧ 失败：跳过，⑨ 里 report_url 用 dashboard_url 兜底
- 步骤 ⑨ 失败：写 outbox，log 里标 push_failed，不阻断流程

---

## 四、飞书卡片模板

参考飞书交互式卡片规范，结构如下：

```
┌─────────────────────────────────────────────┐
│ 🔷 机型监测周报 · 2025-W27                    │  header (蓝主题)
├─────────────────────────────────────────────┤
│ 📊 本周概况                                    │
│ 覆盖机型 12,847 · 命中异常 438 · 环比 +12     │
│                                             │
│ ⚠️ Top 3 需关注                              │
│                                             │
│ 1. iPhone 15 Pro Max 256G                   │
│    orderRate 18.4% → 12.1%  (-34.2%)        │
│    🤖 疑似上周官方降价,GMV 相应下滑            │
│                                             │
│ 2. Redmi K70 Pro                            │
│    orderRate 8.2% → 12.6%  (+53.6%)         │
│    🤖 疑似小米 618 尾款释放,可持续观察          │
│                                             │
│ 3. ...                                       │
├─────────────────────────────────────────────┤
│  [查看完整报告]  [进入监测详情]                  │
└─────────────────────────────────────────────┘
```

- "查看完整报告" 打开飞书云文档
- "进入监测详情" 打开前端 dashboard，URL 带 `?dimension=model&week=W27&from=alert`

---

## 五、配置文件

```
experts/daily_analyst/skills/model_weekly_monitor/
├─ skill.md                    ← 元数据 + 使用说明
├─ workflow.py                 ← workflow 主逻辑
├─ card_template.py            ← 飞书卡片渲染
├─ config/
│   ├─ default.yaml            ← 阈值/超时/并发上限等
│   └─ push_channels.yaml      ← 群 webhook (从环境变量读,不入库)
├─ prompts/
│   ├─ anomaly_analysis.md     ← spawn_agent 用的 prompt 模板
│   └─ example_context.md      ← 给 agent 参考的样例
└─ tests/
    ├─ test_workflow.py        ← 端到端,mock 数据源和 push
    └─ fixtures/
```

---

## 六、AI 归因 prompt 模板要点

`prompts/anomaly_analysis.md` 的核心指令（不粘全文，只列约束）：

- 只输出 JSON，一句话 hypothesis + related_metrics + confidence
- 必须参考 `knowledge/metrics_dictionary.md` 的口径
- 只能基于给定的**本周数据 + 上周数据 + 品类基线**做推理，**不许胡编**外部因素
- 归因限定在 5 类：`价格调整 / 库存/供给 / 竞品动作 / 平台活动 / 季节性/自然波动`
- 找不到可解释因素时，`hypothesis = "无法在现有数据内解释,建议人工排查"`，`confidence = low`
- 长度：hypothesis ≤ 40 字

---

## 七、验收标准

- [ ] Skill 声明能被 Router 正确路由（关键词命中测试）
- [ ] `dry_run=true` 时全流程不推飞书、不改任何持久化数据
- [ ] 一次完整执行 ≤ 120 秒（假数据 1000 条机型 + 50 条异常）
- [ ] Cron 触发和手动触发走完全一样的 workflow 路径
- [ ] 每次执行都在 `data/executions/` 留可回放的日志
- [ ] 卡片按钮里的 `dashboard_url` 参数正确（跟前端 URL 约定一致）
- [ ] 飞书群实测收到卡片，样式与设计稿一致
- [ ] AI 归因随机抽 20 条人工复核，"合理" 比例 ≥ 70%
- [ ] `report_url` / `dashboard_url` / `execution_id` 三个输出准确回填

---

## 八、不做的事

- **不做多品类维度组合分析**（那是 category_weekly_monitor 的事）
- **不做实时监控**
- **不写自己的算 wave 逻辑**，全走 lib
- **不写自己的推送逻辑**，全走 lib
- **不管前端 UI**，只保证 URL 约定
- **不做 A/B 归因假设的多次采样**：单次 spawn_agent 就够，成本控制优先

---

## 九、依赖

- ✅ `monitor_lib_shared` 已实施
- ✅ orchestrator 的 workflow runner + spawn_agent 稳定
- ✅ `knowledge/metrics_dictionary.md` 有机型相关口径条目
- ⚠️ 飞书群 webhook 已开好（用户负责）
- ⚠️ 前端 `dashboard_url` 参数解析已实现（`feature/dashboard-drilldown` 里的工作）

---

## 十、开发估工

| 模块 | 估时 |
|---|---|
| skill.md + Router 关键词验证 | 0.5 天 |
| workflow.py 骨架 | 1 天 |
| card_template.py + push 测试 | 1 天 |
| prompts/ + spawn_agent 联调 | 1 天 |
| Cron 接入 + 端到端 | 1 天 |
| **合计** | **约 4.5 天** |
