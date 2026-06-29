# Router 层

> 架构图的"Router 层" — 读 Skill 元数据 · 产出调用计划

## 设计

```
用户请求
   ↓
Agent 层（main agent）
   ↓ 把问题转给 Router
Router（本模块）
   ↓ 1. load_skills() 扫所有 *.md frontmatter
   ↓ 2. plan_call(query, skills) → 调 LLM 生成 call plan
   ↓ 3. 输出 JSON：{intent, skills:[...], fallback, uncertain, notes}
Agent 层根据 plan 依次执行 Skill
```

## 用法

### CLI

```bash
# 看看扫到了哪些 skill
uv run --project router python -m router --list-skills "dummy"

# 实际跑路由
uv run --project router python -m router "给我 iPhone 14 本周的周报"
```

### 在代码里

```python
from router import load_skills, plan_call

skills = load_skills("/path/to/repo")
plan = plan_call("iPhone 周报", skills)
print(plan.to_json())
```

## 设计取舍

- **模型**：默认 `gpt-5.4-mini`，便宜 + 快。Router 不需要强推理。
- **温度**：0.0，避免路由飘忽。
- **输出**：JSON Object 模式，强制结构化。
- **依赖**：只依赖 `openai` SDK 和 `pyyaml`。不依赖 Codex CLI。

## 不做什么

- ❌ 不执行 Skill（执行在 orchestrator/expert_runner）
- ❌ 不做对抗审查（那是 review_gate 的事）
- ❌ 不维护对话历史（每次路由都是无状态的）

## 测试

```bash
cd router && uv run pytest -q
```
