# Spec · category_weekly_monitor

> **状态**：设计定稿，实施待启动
> **优先级**：P1（依赖 monitor_lib_shared，跟 model_weekly_monitor 90% 同构）
> **归属**：`experts/daily_analyst/skills/category_weekly_monitor/`
> **触发**：cron 每周一 09:30 自动 + 飞书 @ 机器人手动
> **作者**：Kiro
> **最后更新**：2025-07-04

---

## 一、目的

给品类维度（例如"手机 / 电脑 / 相机 / 家电"等一级品类，或后续二级品类）做与机型监测同构的周维度监测。

**核心区别**（跟 model_weekly_monitor 的**唯一**差异）：
- **粒度更粗**：品类数量少（~139 个 vs 机型 12,847 个），但每个品类的绝对流量更大
- **口径细化**：品类漏斗看的是「品类总 UV → 品类订单率」，不涉及 SKU
- **可解释性预期更高**：品类维度波动通常有明确业务动作可解释（活动/供给/政策），AI 归因预期准确率高于机型
- **cron 时间错开**：09:30，避开机型跑批时段

---

## 二、Skill 元数据

```yaml
---
name: category_weekly_monitor
type: workflow
version: 1.0
owner: daily_analyst
description: 品类维度周监测,输出漏斗波动 + AI 归因 + 飞书推送
triggers:
  - cron: "30 9 * * 1"
  - keywords:
      - "品类监测"
      - "品类周报"
      - "本周品类"
      - "品类波动"
inputs:
  week: str | null
  categories: list[str] | null   # 默认全品类
  dry_run: bool = false
  push_channel: str | null
outputs:
  report_url: str
  dashboard_url: str
  anomaly_count: int
  execution_id: str
---
```

---

## 三、Workflow 结构

**跟 `model_weekly_monitor` 完全同构**，只有 3 处不同：

| 步骤 | 差异 |
|---|---|
| ② fetch | `dimension="category"`；可选按 `categories` 白名单过滤 |
| ④ apply_rules | 读 `data/rules/category_rules.json`（阈值更严：品类粒度波动 ±10% 就要看，不是 ±15%） |
| ⑨ push | 卡片模板文案主语换成"品类"，颜色改用青色主题 |

其余全部复用 `model_weekly_monitor.workflow.py` 的实现，通过传参数区分。

---

## 四、目录布局

```
experts/daily_analyst/skills/category_weekly_monitor/
├─ skill.md
├─ workflow.py          ← 极薄的包装,90% 复用 model 的实现
├─ card_template.py     ← 只覆写标题/主色/文案
├─ config/
│   ├─ default.yaml     ← 阈值不同
│   └─ push_channels.yaml
├─ prompts/
│   ├─ anomaly_analysis.md   ← prompt 里"你在分析机型" → "你在分析品类"
│   └─ example_context.md
└─ tests/
    ├─ test_workflow.py
    └─ fixtures/
```

**注意**：如果实施时发现 `workflow.py` / `card_template.py` 里两个 skill 的差异只是 3~5 行配置，那就把差异抽成 `dimension_profile.yaml`，两个 skill 共享同一个 workflow 实现（通过 skill 元数据的 dimension 字段区分）。这个决策等 `model_weekly_monitor` 实施完后做，此时能真实评估差异量。

---

## 五、品类 rules 建议初始值

`data/rules/category_rules.json`：

```json
[
  {
    "id": "category_sharp_drop",
    "condition": "delta_pct < -0.15 and gmv_prev > 500000",
    "priority": "high"
  },
  {
    "id": "category_sharp_rise",
    "condition": "delta_pct > 0.20 and gmv_prev > 200000",
    "priority": "medium"
  },
  {
    "id": "category_uv_drop",
    "condition": "uv_delta_pct < -0.20",
    "priority": "high"
  }
]
```

（正式实施时由业务方 review 调整）

---

## 六、飞书卡片模板要点

差异仅在视觉：

- Header：`🟢 品类监测周报 · 2025-W27`（绿/青主题）
- 主体结构同 model
- 按钮：`[查看完整报告]  [进入品类监测]`

---

## 七、验收标准

- [ ] 全部 model_weekly_monitor 的验收项在此处同样满足
- [ ] `categories` 白名单参数生效，不传时默认拉全品类
- [ ] 跟 model 各自独立跑，不互相干扰
- [ ] 两个 workflow 的代码重复率 ≥ 80%（用 tokei / cloc 度量）
- [ ] cron 时间错开正确（09:00 vs 09:30），日志能验证

---

## 八、不做的事

- **不搞机型 × 品类 交叉分析**：那是未来另一个 skill
- **不为品类维度单独实现算法**：全走 lib
- **不复用 model 的 rules.json**：品类阈值必须独立
- **不承诺"品类监测能定位到具体机型"**：那需要下钻，是下游的事

---

## 九、依赖

同 `model_weekly_monitor`。**额外**依赖：
- `data/rules/category_rules.json` 初始规则集由业务方确认（阻塞项，实施前必须搞定）

---

## 十、开发估工

- 若在 `model_weekly_monitor` 之后做：**约 2 天**（多数在配置和 prompt 微调，代码复用极高）
- 若并行做：**约 4 天**（需要一起做抽象设计，返工风险）

**建议**：串行做，`model_weekly_monitor` 稳定后再开工，节省约 2 天。
