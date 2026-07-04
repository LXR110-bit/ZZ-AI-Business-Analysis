# Spec · project_status

> **状态**：设计定稿，实施待启动
> **优先级**：P2（独立，不阻塞其他 spec）
> **归属**：`experts/daily_analyst/skills/project_status/`（暂归 daily_analyst，未来若职责膨胀可单开专家）
> **触发**：飞书 @ 机器人 + 每周五 17:00 自动一次
> **作者**：Kiro
> **最后更新**：2025-07-04

---

## 一、目的

给用户提供一个**主控视角**：项目当前进展到哪、哪些 skill 上线了、哪些还在 spec 阶段、上周有什么执行结果、下周该聚焦什么。

**核心场景**：
- 用户飞书 @ 机器人"项目现在到哪了"→ 即时生成状态卡片
- 每周五 17:00 自动推一次周度小结到项目群
- 顶层 `PROJECT_STATUS.md` 由此 skill 自动更新（人工可覆盖但不推荐）

**这个 skill 不做业务分析，只做元层面报告**。它扫描代码库、日志、执行历史，产出"项目本身"的状态。

---

## 二、Skill 元数据

```yaml
---
name: project_status
type: workflow
version: 1.0
owner: daily_analyst
description: 主控视角报告,梳理项目进展/阻塞/下一步
triggers:
  - cron: "0 17 * * 5"       # 每周五 17:00
  - keywords:
      - "项目状态"
      - "项目进展"
      - "现在到哪了"
      - "project status"
inputs:
  scope: Literal["all", "monitor", "orchestrator", "frontend"] = "all"
  format: Literal["card", "markdown_doc", "both"] = "card"
outputs:
  status_report_url: str
  updated_md_path: str        # PROJECT_STATUS.md 的路径
  execution_id: str
---
```

---

## 三、数据源（skill 自动扫描）

| 数据源 | 用途 |
|---|---|
| `git log --since='7 days ago'` | 本周提交活动，识别活跃模块 |
| `gh pr list --state all --limit 20` | PR 状态（open / merged / draft） |
| `docs/superpowers/specs/*.spec.md` | 所有 spec 的元数据（状态、优先级、依赖） |
| `data/executions/*.json` | workflow 执行日志（成功率、异常率） |
| `experts/*/skills/*/skill.md` | 已注册的 skill 清单 |
| `.github/workflows/*` | CI 状态（可选，v1 先跳） |

**扫描逻辑**：全部只读，纯本地，不发外网请求（除了 gh CLI）。

---

## 四、Workflow 步骤

```
[start]
  ↓
① scan_repo (读所有上述数据源到内存)
  ↓
② parse_specs (提取每份 spec 头部的状态/优先级)
  ↓
③ collect_execution_metrics (最近 7 天 workflow 执行汇总)
  ↓
④ compute_project_health (定义见下)
  ↓
⑤ spawn_agent(summarize) (让 AI 生成 3-5 句自然语言概述)
  ↓
⑥ render_card + render_markdown
  ↓
⑦ update_project_status_md (覆写顶层 PROJECT_STATUS.md)
  ↓
⑧ push_to_feishu (仅 cron 触发时;手动触发不推,只回消息)
  ↓
[end]
```

---

## 五、"项目健康度" 定义

`compute_project_health` 输出的结构：

```python
{
  "overall_health": "green" | "yellow" | "red",
  "dimensions": {
    "spec_progress": {
      "total": int,
      "done": int,
      "in_progress": int,
      "not_started": int,
      "score": float  # done / total
    },
    "execution_reliability": {
      "runs_7d": int,
      "success_rate": float,
      "score": float
    },
    "code_activity": {
      "commits_7d": int,
      "open_prs": int,
      "stale_prs": int  # > 14 天未更新
    },
    "blocked_items": list[str]  # 阻塞项标题
  },
  "top_risks": list[str]  # AI 生成的风险清单
}
```

**健康度判定规则**（v1 阈值，可调）：
- `red`: `success_rate < 0.6` 或 `blocked_items >= 3`
- `yellow`: `success_rate < 0.85` 或 `stale_prs >= 2`
- `green`: 其余

---

## 六、飞书卡片模板

```
┌───────────────────────────────────────────────┐
│ 🟢 项目状态 · 2025-W27                          │
├───────────────────────────────────────────────┤
│ Spec 进度   ■■■■■□□□□□  50% (2/4 已实施)      │
│ 执行可靠性  ■■■■■■■■■□  92% (72/78 成功)        │
│ 代码活跃度  本周 34 commits · 3 open PR         │
│                                               │
│ 🎯 本周聚焦                                    │
│ · monitor_lib_shared 实施中,预计 W28 完成      │
│ · dashboard PR #12 待重新规划                  │
│                                               │
│ ⚠️ 风险                                        │
│ · PR #10 停滞 21 天,建议关闭或推进              │
│ · category_rules 初始值尚未由业务方确认         │
│                                               │
│ 🤖 一句话总结                                  │
│ 项目主线在 spec 落地阶段,进度稳定,建议下周      │
│ 优先解决 rules 阻塞项。                        │
├───────────────────────────────────────────────┤
│  [查看完整报告]  [打开 PROJECT_STATUS.md]       │
└───────────────────────────────────────────────┘
```

---

## 七、PROJECT_STATUS.md 结构

顶层文件，此 skill 每次执行都覆写：

```markdown
# PROJECT_STATUS

> 由 project_status skill 自动更新
> 最后更新：2025-07-04 17:00 · execution_id=xxx

## 总览
[卡片同款文本]

## Spec 进展
| Spec | 状态 | 优先级 | 依赖 | 预计完成 |
|---|---|---|---|---|
| monitor_lib_shared | in_progress | P0 | - | W28 |
| model_weekly_monitor | not_started | P1 | monitor_lib_shared | W29 |
| ... |

## 最近 7 天 workflow 执行
| Skill | 执行次数 | 成功率 | 平均耗时 |
| ... |

## 开放 PR
[从 gh pr list 拿到的列表]

## 风险与阻塞
[列表]

## 下周聚焦
[AI 生成的 3~5 个 bullet]
```

**首次生成前**：由人手写一份初始 PROJECT_STATUS.md 作为兜底，skill 上线后自动接管。

---

## 八、安全边界

- **只读**：绝不 git commit / push / 修改任何 spec 文件本身
- **写入范围只有一处**：`PROJECT_STATUS.md`（顶层） + 自己的 `data/executions/project_status_*.json`
- 不调用外部 API 生成图表（v1 只文本卡片，图表放 v2）
- 飞书 push 使用与 monitor skill 完全独立的 webhook（避免混发）

---

## 九、验收标准

- [ ] `git log`/`gh pr list` 数据抓取正确
- [ ] Spec 状态解析 100% 覆盖当前 4 份 spec
- [ ] `PROJECT_STATUS.md` 生成后 markdown 语法合法
- [ ] "健康度" 判定与人工感知一致（10 次抽查 8 次以上一致）
- [ ] AI 一句话总结不夹私货，不做业务建议（只做元层面）
- [ ] 手动触发 ≤ 30 秒返回
- [ ] Cron 触发失败不影响主业务
- [ ] 卡片消息成功率 ≥ 95%

---

## 十、不做的事

- **不做业务数据分析**：本 skill 只关注项目管理层面
- **不生成需求文档 / spec**：只汇总现有 spec 的状态
- **不做甘特图或时间线可视化**（v2 再说）
- **不接管人工判断**：AI 总结只是辅助，不给决策

---

## 十一、依赖

- ✅ orchestrator 的 workflow runner + spawn_agent
- ⚠️ 首次运行前需要人工手写初版 `PROJECT_STATUS.md`
- 无阻塞项

---

## 十二、开发估工

| 模块 | 估时 |
|---|---|
| repo scanner + spec 解析器 | 1 天 |
| execution metrics 汇总 | 0.5 天 |
| card + markdown 渲染 | 1 天 |
| AI summary prompt + 测试 | 0.5 天 |
| Cron + 端到端 | 0.5 天 |
| **合计** | **约 3.5 天** |
