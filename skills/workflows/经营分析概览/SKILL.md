---
name: business-overview
description: 经营分析概览 workflow，用于大盘、品类、机型链路分析、归因和策略建议；当用户询问经营分析、大盘概览、品类异动、转化链路、机型下钻或经营复盘时使用。
metadata:
  workflow_id: business_overview
  type: workflow
---

# 经营分析概览 Skill

## 架构

PR42 / v1.3.0 第一阶段采用轻量上线边界：`run.py` 先把现有 `/api/dashboard`
数据确定性转换为 v0.4 `InputDict`，并提供可通过 assertions 的保底判断；
看板定时 AI 生成由 `model-tag-monitor/scripts/generate-business-overview-insights.js`
在刷新健康检查之后触发，且默认关闭。完整 spawn_agent 分步判断仍作为目标架构保留。

```
用户请求
  ↓
Router 读此 SKILL.md → 识别 type=workflow
  ↓
Dispatch 到 run.py（主流程）
  ↓
Step 1 (Python)：取数算三基准(环比/同比/近8周) + 数据可信度预检 → input_dict
  ↓
Step 2 (spawn_agent)：数据可信度复核 + 三基准 + 趋势 + 链路判断 → link_verdict
  ↓  （待核标签=true 时，全报告结论降级"待核"，风险不下🟢）
Step 3 (spawn_agent)：品类归因(二维矩阵) + 此消彼长 + 仲裁 → attribution_verdict
  ↓
Step 4 (spawn_agent, 按需)：机型归因 → model_verdict
  ↓
Step 5 (Python/spawn_agent)：金字塔组装(SCQA序言+塔尖+三问分组) → 最终报告
```

## 数据流

- Router 只认此文件，不读 prompts，不执行流程
- `run.py` 是 workflow 主入口；Phase 1 负责确定性 dashboard adapter、保底判断、schema/assertion 校验
- 看板生产侧 AI 生成不在 `run.py` 内直接 spawn，而由 model-tag-monitor 定时脚本用只读 Codex CLI 生成缓存
- `prompts/` 只用于 LLM 判断节点，**不含 YAML frontmatter**（避免被 Router 误识别为 skill）
- `__main__.py` 支持 `python -m skills.workflows.经营分析概览`

## 接口

输入：
- `week`：必填，周标签，如 `2026-W27`
- `scope`：选填，分析范围，如 `大盘` / `发展品类` / `无人机`，默认 `大盘`

输出：
- `summary`：老板风格的一句话结论
- `insights`：核心发现，每条带关键数据支撑
- `actions`：下周最优先行动，1-2 条，每条带停止条件
- `risk_level`：`🔴` / `🟡` / `🟢`

## 判断规则来源

分析判断逻辑来自老板思维模式框架（A–E），详见：
- `references/00-Skill-总纲.md`
- `references/01-Skill-大盘链路定性+风险等级+上周预判检核.md`
- `references/02-Skill-品类簇归因+策略验证+资源分配.md`
- `references/03-Skill-品类下钻归因+影响度+可解决度+停止条件.md`
- `references/04-Skill-机型层归因+规律提炼+跨品类复用.md`
- `references/05-Skill-综合判断+情绪基调+下周行动+整体预判检核.md`

## 执行约束

1. **Step 1 必须是纯 Python**，不调用 LLM；Step 5 组装可纯 Python，金字塔文案可选 spawn_agent
2. **Phase 1 不在 workflow 内强制 spawn_agent**；Step 2/3/4 可用确定性保底或后续受控 LLM 判断，且每个 prompt 必须输出结构化 JSON
3. **Step 4 按需触发**：仅当 Step 3 输出 `trigger_model_drill=true` 时执行
4. **每个 spawn_agent 调用必须附带 assertions.py 的守门检验**，输出不合法时重试
5. **数据可信度先于一切（v0.4）**：Step 2 判 `待核标签=true` 时，风险等级不得为 🟢，最终结论加"待核"
6. **归因走二维矩阵（v0.4）**：责任主体(可多个,各带证据) × 时间属性；"不可归因"必须说明排除了哪些
7. **最终输出走金字塔（v0.4）**：塔尖单一判断句+动词(加注/持平/收手)+对象，核心发现按老板三问(大盘安全/预判兑现/资源怎么动)MECE分组，每条挂 Skill 凭据
8. **看板定时 AI 必须只读**：服务器调用必须使用 `codex exec --sandbox read-only --ephemeral --output-schema --output-last-message`，禁止使用 bypass sandbox；失败时保留确定性洞察

## 判断逻辑版本

当前 v0.4，与 `references/` 知识文件同步。v0.4 六项补齐：
数据可信度校验、三基准对比、多期趋势、品类间此消彼长、归因二维矩阵、论点交叉仲裁。
