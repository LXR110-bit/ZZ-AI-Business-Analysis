# 架构讨论交接文档：workflow-first + agent-on-judgment

> 用途：新会话讨论「数据分析系统架构该怎么设计」的起点。带着这份进新会话，不用从头重建认知。
> 生成时间：2026-07-01
> 仓库：`/Users/lilixiaoran/工作/转转/ai数据分析工作流`（origin：`LXR110-bit/ZZ-AI-Business-Analysis`，当前 tag `v0.3.0`）

---

## 一、核心议题（用户提出的问题）

> "当前数据分析的场景是不是更应该用 workflow 的架构 + 归因判断使用 agent？现在的架构是不是有问题？"

用户直觉：**workflow 打底，agent 只在归因/判断节点上用**。现架构把 agent 铺在所有节点，是过度使用。

这份文档的立场：**用户直觉基本正确**。下面是支撑论据和待设计的方案骨架，新会话在此基础上深化，不是从零开始。

---

## 二、现架构（v0.3.0 事实，已读代码确认）

```
飞书 webhook → event_handler → Router(LLM) → expert_runner → codex exec agent → Review Gate(LLM) → reply
```

| 组件 | 实现 | 文件 |
|---|---|---|
| Router | **LLM** 读 Skill frontmatter 出 JSON 调用计划 | `router/src/router/planner.py` |
| Skill loader | 扫 markdown frontmatter（name/description/trigger） | `router/src/router/skill_loader.py` |
| Expert | **每次请求起一个 `codex exec` 子进程**，agent 自己 plan/tool/loop | `orchestrator/src/orchestrator/expert_runner.py` |
| Skill | markdown 提示词（引导 agent，不是可运行代码） | `experts/<expert>/skills/*.md` |
| Review Gate | LLM critic 对抗审查，§1-§7 自检 | `review_gate/`（PR #5 merged） |

**代价**：每次用户提问 = 至少 3 次 LLM 往返 + 1 个完整 agent 循环。

现有 experts：`daily_analyst` / `diagnostician` / `user_analyst`
daily_analyst 现有 skills：`multidim_analysis.md` / `sql_first_phase.md` / `weekly_report.md`

---

## 三、问题诊断（4 条）

1. **Router 选完 Skill 直接把整请求丢给 codex exec**，中间没有"这 Skill 是 workflow 还是 agent"的分叉。最机械的 SQL 取数也走完整 agent 循环。

2. **Skill 是 markdown 引导**，等于把工作流写成自然语言，再靠 LLM 翻译执行一遍 —— 确定性任务里 agent 的自由度反而是噪音。

3. **Review Gate 是通用 LLM 对抗审**。但 SQL 结果正确性该靠 **assertion**（分区非空 / UV>0 / 下单量≥成交量），是代码检查不是 LLM 检查。

4. **知识库（wiki_seed 4 张表：底表/字段/维值/口径）本身就是决策论**，应编译成 workflow 参数，而不是让 agent 每次"查一遍再拼"。

**实锤证据**：codex 用 agent 方式做 `sql_first_phase`（纯参数化 SQL 取数），`.agent-locks/codex-sql-first-1782816109.yml` 的 `expected_done` 是 2026-06-30T18:01，到 07-01 仍 dirty 未交货。agent 用错场景的典型表现。

---

## 四、场景分类（哪些该 workflow / 哪些该 agent）

| 场景 | 主体 | 结论 |
|---|---|---|
| 周报 SQL 取数 | 参数化 SQL + 模板拼 Excel | ❌ workflow |
| 机型漏斗中间表（`sql/机型维度中间表取数.sql`，5 张固定 sheet） | 固定 group by | ❌ workflow |
| 用户画像取数 | 圈人群→跑标签→汇总 | ❌ workflow（除非要"聪明选标签"→hybrid） |
| **异动诊断** | 看跌→判显著性→决定下钻维度→停不停→归因 | ✅ **agent 判断** |
| 探索性 EDA | "你觉得这数据有啥问题" | ✅ agent |

一句话：**agent 只在"归因 / 异动判断 / 开放性推理"节点上用。**

---

## 五、建议架构骨架（待新会话深化）

```
Router(LLM 或规则) → 计划：
  ├─ workflow 型 → 直接跑 pipeline（SQL / Excel / 报表模板）
  │                 └─ 只在"归因/异动判断"节点嵌 mini-agent
  └─ agent 型   → 现有 codex exec 路径（探索性 / 未见问题）
                  └─ Review Gate 对抗审
```

对应改造点（待讨论，非定论）：
- Skill frontmatter 加 `type: workflow | agent | hybrid`
- workflow 型 Skill = 可执行模块（`__main__.py` + `params.py` + `.sql`），不是 markdown prompt
- hybrid 型 = pipeline 主干 + `attribute()` / `explain()` 的 agent 步骤
- Review Gate 拆两条：assertion（workflow 结果）vs LLM 审（agent 输出）

---

## 六、重要立场 / 边界

- **不要推翻 v0.3.0**。它作为"通用 agent 底座"能跑，MCP 层 / 飞书对接 / Review Gate 基础设施都在。
- 争议点应落在"**下一个 PR 是否做 workflow 层**"，而非重写。
- dirty 状态里那 6 个 SQL 文件（`sql/`）是 workflow 层最好的起点：直接组成可执行模块，别再包 markdown prompt。

---

## 七、待决问题（新会话该回答的）

1. Router 分叉逻辑：LLM 判 workflow/agent，还是靠 Skill 声明的 `type`？
2. workflow 引擎自己写，还是复用现成（比如仓库里已有 `工作流/` 目录？需确认）？
3. hybrid 型里 agent 步骤的接口长啥样（输入/输出契约）？
4. assertion 层的规则从哪来 —— 手写还是从 `knowledge/` 的口径定义生成？
5. 迁移路径：现有 3 个 markdown skill 怎么归类 / 改造？

---

## 八、相关文件速查

- 架构图：`category_analysis_agent_architecture_v2.png`、`知识库架构图.drawio`
- 现有 plan 目录：`docs/superpowers/plans/`（只有 1 份 wiki-seed-sync）
- 知识库定义：`knowledge/`、`wiki_seed/`（4 张表 JSON）
- 待处理 dirty 分支：`agent-codex/feat/sql-first-phase`（未 push，lock 已超期）

---

## 九、当前 git 状态（新会话可能要先清理）

- Mac 本地在 `agent-codex/feat/sql-first-phase`，HEAD `11cbb03`，**落后 origin/main（`7fe58e9` / v0.3.0）10 个 commit**
- 工作树 dirty：codex 半途停下的 sql_first_phase 活（4 改 + 5 新）
- 远端已 merge 到 PR #9，MVP-2 主链路（webhook→router→expert→review gate→reply）已通
- PR #10（CI AI Code Reviewer）still OPEN
