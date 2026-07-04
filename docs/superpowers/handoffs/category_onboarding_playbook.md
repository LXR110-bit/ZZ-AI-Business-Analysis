# Category 维度接入 Playbook（品类监测接入指南）

> **目的**：把机型（model）维度接入的完整链路提炼成模板，未来接品类（category）维度时按图索骥、逐步照抄，最大化复用、最小化返工。
>
> **适用读者**：接手 category 接入的 sub-agent（或主控自己）
>
> **作者**：主控 Agent
>
> **最后更新**：2026-07-04
>
> **状态**：定稿，实施等待

---

## 一、这份 playbook 从哪来

机型维度（`monitor_lib_shared` / `model_weekly_monitor` / dashboard 前端）已经跑通到"数据 Agent A 级收工 + 前端契约对齐 + 飞书推送 MVP + Node 版 `/api/monitor` 在生产环境跑着"的状态。**这份文档把这段接入过程逆向工程成模板**，让 category 维度接入时不用再走弯路。

**权威来源**：
- 数据链路：`skills/机型周数据/pipeline.py`（ai数据导入 Agent 从代码查证，见 PROJECT_STATUS "数据血缘"章节）
- 算法层：`orchestrator/src/orchestrator/lib/monitor/`（PR #19 合入 main）
- 契约：`docs/superpowers/handoffs/data_to_frontend_contract.md` v1.0
- Node 版：zz-server `/root/model-tag-monitor/`（`phase1_server_infra_handoff.md`）
- 飞书推送：`tools/feishu_push/send_card.py`（PR #14 → 补合 #17）
- Spec 定稿：`docs/superpowers/specs/category_weekly_monitor.spec.md`

---

## 二、一图看懂整条链路（机型现状 + category 变更点）

```
【上游数据】
   Zzhu 平台每日邮件 (zip ~50MB)
      ↓ IMAP 抓取 → openpyxl 解 xlsx → pandas group by
      ↓
   pipeline (skills/机型周数据/pipeline.py)                       ⚠️ 变更点 1
      ↓ upsert_tab() 直接写飞书（并行两张终点表）
      ↓
   ├─ SUMMARY_TOKENS[月]    → 飞书周汇总表（机型级）              ⚠️ 变更点 2
   └─ DAILY_AVG_TOKENS[月]  → 飞书周日均表（机型级）              ⚠️ 变更点 2

【zz-server 上跑的 Node 版监测服务】
   /root/model-tag-monitor/ (pm2 守护，端口 8848)
      ↓ 从飞书表拉数据 → 归一化 → 落 cache.json
      ↓
   GET /api/data?week=&category=                                  ✅ 已支持 category 参数
   GET /api/monitor                                               ⚠️ 变更点 3

【Python 版监测算法库（主控本 repo）】
   orchestrator/src/orchestrator/lib/monitor/
      ├─ schemas.py       ✅ 已支持 dimension = "model" | "category"
      ├─ wave.py          ✅ 算法维度无关（按 category+modelName 聚合已实现）
      ├─ rules.py         ✅ MonitorRules 通用，需换品类 rules.json
      ├─ fetcher.py       ✅ 已实现 _aggregate_to_category（mock 层聚合）
      └─ pusher.py        ✅ 已实现 send_card 双通道封装

【前端 Dashboard】
   前端仓库 src/dashboard.js
      ├─ composeDashboard(...)   ✅ 已实现，机型维度已验证
      ├─ test/fixtures/          ⚠️ 变更点 4（要 category fixture）
      └─ 机型下钻页              🔜 前端 Agent 正在推进

【飞书推送】
   tools/feishu_push/send_card.py                                 ⚠️ 变更点 5（换主题色 + 标题）
      ↓ zz-server → AI分析群/业务群
```

---

## 三、5 个变更点详解

### 变更点 1：pipeline.py 加 category 聚合分支

**现状**：`pipeline.py` L808/816 只调 `upsert_tab(summary_token, ..., df_sum, ...)` 写机型级汇总表 + 日均表，没有 category 分组代码。

**要做的**：
1. 在 `upsert_tab` 调用之前，加一层 `df_cat = df_sum.groupby(['week', 'category']).agg(...)` 聚合
2. 聚合口径（**跟 Node 版 sync.js 保持一致**）：
   - `evaUv`：`sum()`
   - `orderUv`：`sum()`
   - `evaCount`/`orderCount`/`shipCount`/`dealCount`/`returnCount`：`sum()`
   - **5 个转化率**：**不能加权平均**，必须**分子分母 sum 后重新算**（`evaRate = sum(evaCount) / sum(evaUv)`），否则跟机型级的率算法冲突
3. 新增 `SUMMARY_TOKENS_CATEGORY[月] = <飞书新表 token>` 和 `DAILY_AVG_TOKENS_CATEGORY[月] = <飞书新表 token>`
4. `upsert_tab(summary_token_cat, ..., df_cat, ...)` 写品类汇总表 + 品类日均表

**预期新增行数**：~40 行

**输出验证**：跑完 pipeline 后手动去飞书新建的品类汇总表看，抽 3 个品类 × 3 周对比机型级汇总的分子分母 sum 是否一致。

### 变更点 2：飞书新建 2 张品类表

**要做的**：
1. 飞书里新建 `2026-06 品类周汇总表` 和 `2026-06 品类周日均表`（复制机型表模板即可）
2. 拿到 `app_token`（就是 URL 里的 `TzkVs1...` 那段）
3. 更新 `constants.py`：
   ```python
   SUMMARY_TOKENS_CATEGORY = {"2026-06": "TzkVs1...cat"}
   DAILY_AVG_TOKENS_CATEGORY = {"2026-06": "FRxvsY...cat"}
   ```
4. 表结构（跟机型表 95% 一致，唯一差异是**没有 modelName 字段**）：

| 字段 | 类型 | 说明 |
|---|---|---|
| week | 单选 | ISO 周格式 "2026-W27" |
| category | 单选 | 品类名（"手机" / "电脑" / ...） |
| evaUv | 数字 | |
| orderUv | 数字 | |
| evaCount / orderCount / shipCount / dealCount / returnCount | 数字 | |
| evaRate / orderRate / shipRate / dealRate / returnRate | 数字 | 品类级重算，不是机型加权 |

**阻塞**：飞书表 URL 只能用户提供或者用户手动创建；主控和 sub-agent 都没有飞书 admin 权限。

### 变更点 3：zz-server Node 版 sync.js 加 category 聚合分支

**现状**：Node 版 `sync.js` 从飞书机型级表拉数据 → 归一化 → 出 `cache.json`，`GET /api/data?category=X` 是**在机型级数据上按 category 过滤**（不是聚合成品类粒度）。

**要做的**：
1. 在 `sync.js` 里加一段：如果 `SUMMARY_TOKENS_CATEGORY` 里有配置，拉品类表，落 `cache_category.json`
2. 加 `GET /api/monitor?dimension=category` 端点：读 `cache_category.json` → 跑 monitor 算法 → 返回同结构 JSON
3. 或者更简单的做法：**只出品类级 cache**，让 `/api/monitor` 支持 `dimension` 参数，内部分流

**修法路径**（阻塞：主控没 SSH）：
- 用户在 Mac 上 `ssh zz-server` 改
- 或未来 Python 版接管生产时，直接跳过 Node 版这一步

**如果暂时不改 Node 版**：可以用 Python 版 fetcher 的 `_aggregate_to_category` 直接从机型级 `cache.json` 聚合出品类级数据（数据 Agent 已实现 mock 层聚合），跳过 Node 版的品类分支。**这是短期可行方案**。

### 变更点 4：前端 Dashboard 增加品类维度视图

**现状**：`composeDashboard()` 已经跑通机型维度，`test/fixtures/monitor.json` 只有机型 fixture。

**要做的**：
1. 拿到品类维度的 `/api/monitor?dimension=category` 真实响应（等变更点 3 完成，或者用 Python 聚合出的 mock）
2. 落到 `test/fixtures/monitor_category.json`（2-3 MB 级别）
3. 单测：加 `test/compose-dashboard-category.test.js`，跑同样 6 case（契约 shape / GMV 兜底 / 排序 / 空 pool / 未同步保护 / cache 命中）
4. UI：品类维度 tab 或独立页，视觉主题**改用青色**（跟机型的橙色区分），文案主语换成"品类"

**契约**：**完全一样**（`WaveResult.category` 已经存在，`modelName` 字段品类维度返回 `null` 或聚合别名）。`data_to_frontend_contract.md` 无需改动。

### 变更点 5：飞书卡片模板加品类版

**现状**：`tools/feishu_push/send_card.py` 有 3 个模板（`monitor_weekly` / `daily_kpi` / `test_probe`），都是机型主题（🔵 蓝/橙色）。

**要做的**：
1. 加一个 `monitor_weekly_category` 模板（拷贝 `monitor_weekly`）
2. Header：`🟢 品类监测周报 · 2025-W27`（青色主题）
3. 主体结构不变（波动 flag / trend / pool top）
4. 按钮文案：`[查看完整报告]  [进入品类监测]`
5. 单测：`test/test_monitor_category_card.py` 拷 `test_monitor_weekly_card.py`

**预期新增代码**：~30 行 + 5 行单测

---

## 四、目录结构（跟 model_weekly_monitor 同构）

新建 skill：
```
experts/daily_analyst/skills/category_weekly_monitor/
├─ skill.md                       ← 跟 model 版基本一致，改元数据 dimension=category
├─ workflow.py                    ← 极薄包装，90% 复用 model 的实现
├─ card_template.py               ← 只覆写标题/主色/文案
├─ config/
│   ├─ default.yaml               ← 阈值不同（±10% vs ±15%）
│   └─ push_channels.yaml         ← 独立品类监测群 webhook
├─ prompts/
│   ├─ anomaly_analysis.md        ← "你在分析机型" → "你在分析品类"
│   └─ example_context.md
└─ tests/
    ├─ test_workflow.py
    └─ fixtures/
```

**注意**：如果 `model_weekly_monitor` 已经实施完毕，且发现 `workflow.py` / `card_template.py` 里两个 skill 的差异只是 3~5 行配置，就把差异抽成 `dimension_profile.yaml`，两个 skill 共享同一 workflow 实现（这个决策 spec §四也提到了）。

---

## 五、接入 checklist（照抄跑一遍即可）

### Phase 1：地基（用户参与，1-2 小时）

- [ ] **飞书表创建**：新建 `2026-06 品类周汇总表` + `2026-06 品类周日均表`（用户操作，主控无权限）
- [ ] 用户提供两表的 `app_token`
- [ ] 主控更新 `constants.py`：`SUMMARY_TOKENS_CATEGORY` / `DAILY_AVG_TOKENS_CATEGORY`

### Phase 2：上游数据管道（ai数据导入 Agent 主责，1-2 天）

- [ ] `pipeline.py` 加 `_group_to_category(df_sum)` 函数（分子分母 sum 后重算率）
- [ ] 加 `upsert_tab(summary_token_cat, ..., df_cat, ...)` 调用
- [ ] 单测：mock df_sum 输入 → 验证 df_cat 输出的 5 个率算法正确
- [ ] 跑一次 `pipeline --months 2026-06 --skip-notify`，抽 3 个品类 × 3 周对拍飞书表数据
- [ ] 备份现有 `pipeline.py` + git 化（如未 git 化）+ 清 12 个 `.bak` 文件

### Phase 3：Node 版 API（可选，暂缓）

**如短期不改 Node 版**：跳过此 Phase，用 Python fetcher `_aggregate_to_category` 从机型级 cache 聚合。

**如决定改 Node 版**（需 SSH 权限）：
- [ ] `sync.js` 加品类表拉取分支
- [ ] `/api/monitor` 加 `dimension` 参数
- [ ] pm2 restart 验证
- [ ] 抽样 curl 验证响应结构

### Phase 4：Python 版监测算法（数据 Agent 主责，0.5 天）

- [ ] 验证 `fetcher.py` 的 `_aggregate_to_category` 在真实 cache.json 上跑通（数据 Agent 已实现 mock 层，需扩展到 HTTP 真实版）
- [ ] 新建 `data/rules/category_rules.json`（用户/业务方 review 阈值，spec §五给了建议初始值）
- [ ] 跑一次真实数据等价性验证（category 维度 10 品类对拍，如有 Node 版品类 monitor 参考）
- [ ] 单测 `test_rules_category.py` + `test_wave_category.py`

### Phase 5：飞书推送（0.5 天）

- [ ] `tools/feishu_push/send_card.py` 加 `monitor_weekly_category` 模板
- [ ] 单测（拷 `test_monitor_weekly_card.py`）
- [ ] 真发验证：品类监测群或 AI分析群，抽样一条

### Phase 6：Skill 落地（1-2 天）

- [ ] 新建 `experts/daily_analyst/skills/category_weekly_monitor/` 目录（照抄第四章结构）
- [ ] `workflow.py` 传 `dimension="category"` 给 lib
- [ ] `card_template.py` 覆写主题色 + 文案
- [ ] `config/default.yaml`：cron `30 9 * * 1`（错开机型的 09:00）
- [ ] `prompts/anomaly_analysis.md`：品类归因 prompt
- [ ] 集成测试：跑一次完整链路 `week=2026-W27 --dry_run`

### Phase 7：前端（前端 Agent 主责，1 天）

- [ ] 拿到品类维度真实响应，落 `test/fixtures/monitor_category.json`
- [ ] `composeDashboard` 加 dimension 分支或复用（视 API 层设计）
- [ ] 6 case 单测复制
- [ ] UI 加品类 tab / 独立页，青色主题
- [ ] 前后回归 KPI 一致性

### Phase 8：验收 + 上线

- [ ] cron 触发一次品类监测周报（周一 09:30）
- [ ] AI分析群/品类群收到卡片，视觉 + 数据双验证
- [ ] `data/monitor_output/category_2026-W27.json` 落盘
- [ ] Dashboard 显示品类维度视图

**总估工**：约 5-7 天（视上游数据/Node 版是否改动、rules 业务方 review 速度）

---

## 六、阻塞与预置解法

| 阻塞 | 影响 Phase | 解法 |
|---|---|---|
| 飞书 admin 权限 | 1 | 用户手动创建两张品类表，提供 app_token |
| category_rules 初始值 | 4 | 用 spec §五 建议初始值起步，业务方 review 后调整 |
| SSH 到 zz-server（台湾 HiNet 阻塞） | 3 | 短期用 Python fetcher `_aggregate_to_category` 从机型 cache 聚合；长期等用户或 SSH 通道恢复 |
| Node 版 wave.js trend `{}` bug（Issue #21） | 无直接影响 | 品类维度走 Python 版聚合，天然不受此 bug 影响 |

---

## 七、给未来 sub-agent 的引导词（category 接入 Agent）

**如果未来要拉一个新 sub-agent 专职做 category 接入**，用下面这段作为它的 bootstrap 引导：

```
你是"category 数据接入 Agent"，专职做品类维度接入。

## 你的目标

把机型维度已经跑通的整条链路复用到品类维度，产出 category_weekly_monitor skill + 品类监测周报能自动跑通。

## 你的资源

- 完整接入 playbook：docs/superpowers/handoffs/category_onboarding_playbook.md（照 checklist 跑）
- Spec 定稿：docs/superpowers/specs/category_weekly_monitor.spec.md
- 契约：docs/superpowers/handoffs/data_to_frontend_contract.md（不用改）
- 数据血缘：PROJECT_STATUS.md 里的"数据血缘"章节
- Python 版 monitor_lib_shared 已支持 dimension = "model" | "category"（PR #19 合入 main）

## 你的边界

- 你负责：Phase 2 (pipeline 品类聚合) + Phase 4 (Python 版验证) + Phase 6 (skill 目录)
- 你不负责：Phase 1 (飞书建表，等用户) / Phase 3 (Node 版 API，等 SSH 或跳过) / Phase 5 (飞书推送，可协调飞书推送 Agent 重启) / Phase 7 (前端，前端 Agent 主责)
- 遇到跨 phase 阻塞：通过主控协调，不越权

## 你的交付节奏

- 完成一个 Phase 就报回主控（不憋大招）
- 每次报回带：Phase 名 / 做了什么 / 单测状态 / 有没有阻塞
- 主控可能给你派活或者驳回，正常
- 收尾时报告：整体进度 / 遗留项 / 建议下一步

## 关键决策已敲定

- 品类率算法：分子分母 sum 后重算，不用加权平均（spec §四 + playbook §三变更点 1）
- 品类表结构：跟机型表 95% 同构，无 modelName 字段
- cron 时间：09:30（错开机型 09:00）
- 视觉主题：青色（区分机型的橙色）
- 独立品类 rules.json（不复用机型的）
```

---

## 八、跟机型接入的差异点（对照速查）

| 维度 | 机型 | 品类 |
|---|---|---|
| 粒度 | ~12,847 个机型 | ~139 个品类 |
| 上游表 | 机型汇总表 + 日均表 | 品类汇总表 + 日均表（新建） |
| 分组键 | (week, category, modelName) | (week, category) |
| 5 个率算法 | 分母 sum 后重算 | **同**（保持一致） |
| Rules 阈值 | 波动 ±15% | 波动 ±10%（更敏感） |
| cron 时间 | `0 9 * * 1` | `30 9 * * 1` |
| 视觉主题 | 橙色 | 青色 |
| Rate 分母保护 | minEvaUv=15 | 同左（品类流量大，可能不需要） |
| Node 版 API | `/api/monitor` | `/api/monitor?dimension=category` （新增，或 Python 聚合） |
| 数据 fixture | 2.86MB | 预计 200KB-500KB（品类少 92 倍） |
| AI 归因预期准确率 | 中等 | 更高（业务动作可解释性强） |
| 交叉分析 | 不做 | 不做（未来独立 skill） |

---

## 九、后续演进

Category 维度接入跑通后，可能的下一步（**不在本次范围内**）：

1. **一级品类 → 二级品类下钻**：品类粒度可以再细分
2. **品类 × 机型 交叉分析**：品类波动时定位具体机型（下钻）
3. **归因 skill**：品类波动时自动查活动 / 供给 / 政策数据
4. **每日粒度品类监测**：目前只做周维度，日粒度 spec 未来独立

---

## 十、参考文档索引

- `docs/superpowers/specs/model_weekly_monitor.spec.md` —— 机型 skill 定稿
- `docs/superpowers/specs/category_weekly_monitor.spec.md` —— 品类 skill 定稿
- `docs/superpowers/specs/monitor_lib_shared.spec.md` —— Python 算法库定稿
- `docs/superpowers/specs/monitor_lib_parity_ci.spec.md` —— 未来 Python vs Node 长期等价性 CI
- `docs/superpowers/handoffs/data_to_frontend_contract.md` —— 数据契约 v1.0
- `docs/superpowers/handoffs/phase1_server_infra_handoff.md` —— zz-server 基础设施
- `docs/superpowers/handoffs/data_agent_status_2025-07-04_pm.md` —— 数据 Agent 交付状态
- `PROJECT_STATUS.md`（数据血缘章节）—— 上游数据链路权威描述
- Issue #21 —— Node 版 wave.js trend 修复（对品类维度无影响）
- PR #19 —— Python 版 monitor_lib_shared + CI（本模板的算法层地基）
