# Review Gate 层

> 架构图的「Review Gate 强制门」— 业务输出对抗审查，未通过 §6 自检禁止交付

## 设计

```
Agent 输出  ─┐
原始任务    ─┼─→ Review Gate (critic LLM) ─→ Verdict (PASS/FAIL + checks + issues)
原则层      ─┘                                  │
                                                ├─ PASS → 输出可交付
                                                └─ FAIL → 打回 agent 重写
```

Critic 是**对抗性**的 — 工作是找漏洞，不是给鼓励。每次走 6 项检查：

| 检查 | 标准 |
|---|---|
| §1 三层穿透 | 上游/市场/内部三角度都实质性覆盖 |
| §2 生命周期×阈值 | 标注阶段 + 阈值距离 |
| §3 价值链瓶颈 | 列出链条 + 定位瓶颈 + 建议围绕瓶颈 |
| §4 异动诊断四问 | 凡涨/跌解释，4 问全答 |
| §5 动作闭环证据链 | 建议带验证/基线/预期/成本/ROI |
| §7 严谨性兜底 | 数字带来源、口径清晰、不编造 |

非分析任务（如"列邮件"）→ critic 识别 N/A → PASS。

## 用法

### 安装
```bash
cd review_gate && uv sync
```

### CLI
```bash
python -m review_gate \
    --task "生成 iPhone 14 周报" \
    --output @./agent_draft.md \
    --principles principles/core.md
```

退出码：`0` = PASS（可交付）/ `1` = FAIL（需重写）

### 在代码里
```python
from review_gate import review

verdict = review(
    task="iPhone 14 周报",
    agent_output=draft_text,
    principle_text=open("principles/core.md").read(),
)

if verdict.passed:
    deliver(draft_text)
else:
    for issue in verdict.issues:
        print(f"§{issue.check}: {issue.what} → {issue.fix}")
```

## 严苛性是 by design

Critic 偏严 — **宁可误报，不能漏放**。常见 FAIL 原因：
- 数字未标 SQL 来源 → FAIL §7
- 动作 ROI 写"待评估" → FAIL §5
- 解释涨跌跳过四问 → FAIL §4
- 动作未围绕已定位瓶颈且未标"次优先级" → FAIL §3

如果觉得 critic 误报，**改 agent 输出更严谨**，不要降 critic 标准。

## 设计取舍

- **模型**：`gpt-5.5`（深推理；router 用 mini 是因为路由不做判断）
- **温度**：0.0
- **超时**：180s
- **HTTP**：用 `requests` 不用 openai SDK（中转站拒 stainless 头）
- **JSON mode**：`response_format={"type":"json_object"}` 强制结构化

## 不做什么

- ❌ 不修改 agent 输出（只判定）
- ❌ 不接入 orchestrator（下个 PR 做）
- ❌ 不审查代码（那是 CI AI Code Reviewer 的事）

## 测试

```bash
cd review_gate && uv run pytest -q  # 期望: 16 passed
```
