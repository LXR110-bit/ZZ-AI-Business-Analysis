# PROJECT_STATUS

> 项目主控视图。初版由人工维护，`project_status` skill 上线后 AI 自动接管。
> 最后更新：2026-07-04 · 主控 Agent（手工）

---

## 一句话总结

多 Agent 数据分析工作流 v0.4 架构已定稿实施中。本周把机型监测项目（`model-tag-monitor`）纳入体系，产出 4 份 spec，进入实施等待期。

---

## 阶段定位

我们在**从「工具脚手架」升级到「多 Agent skill 体系」的关键过渡期**。

```
[✅ 已完成]                        [▶ 我们在这]              [下一步]
─────────────                     ────────────              ────────
• v0.4 架构定稿                    • 4 份 spec 落地           • 实施 monitor_lib_shared
• orchestrator/router 骨架         • model-tag-monitor 归驻    • 实施 model_weekly_monitor
• 3 个专家 agent 挂载              • dashboard 前端暂缓        • 实施 category_weekly_monitor
• model-tag-monitor 采集/前端      • project_status 立项       • project_status 上线
```

---

## Spec 进展

| Spec | 状态 | 优先级 | 阻塞 | 估工 | 建议时间窗 |
|---|---|---|---|---|---|
| monitor_lib_shared | ✅ **已实施到 main**（PR #19） | P0 | 无 | 已交付 | W27 完成 |
| model_weekly_monitor | 📝 定稿待启动 | P1 | monitor_lib_shared ✅ / fetcher HTTP 真实版 | 4.5 天 | W28 |
| category_weekly_monitor | 📝 定稿待启动 | P1 | monitor_lib_shared ✅ / rules 业务确认 / fetcher HTTP 真实版 | 2 天 | W29 |
| project_status | 📝 定稿待启动 | P2 | 无 | 3.5 天 | 可并行 |
| monitor_lib_parity_ci | 📝 定稿待启动 | P2 | monitor_lib_shared 稳定 3-5 天（本 PR 合入后计时） | 0.5 天 | W28 后期 |

Spec 全文见 [`docs/superpowers/specs/`](./docs/superpowers/specs/)。

---

## 关联 PR

| PR | 状态 | 说明 |
|---|---|---|
| [#12 · dashboard 下钻链路](https://github.com/LXR110-bit/ZZ-AI-Business-Analysis/pull/12) | ⏸ 暂缓 | 前端下钻交互，等 monitor skill 落地后重新规划输出面板 |
| #13 · 主控 W27 第一批 | ✅ 已合并 | 4 份 spec + 3 份 handoff + PROJECT_STATUS |
| #14 · 飞书推送 MVP（原始） | ⚠️ merge 但 base 走废弃分支 | 补合见 #17 |
| #15 · 数据契约 v1.0 | ✅ 已合并 | `docs/superpowers/handoffs/data_to_frontend_contract.md` |
| #16 · PROJECT_STATUS 飞书推送登记 | ✅ 已合并 | doc 同步 |
| #17 · 飞书推送 MVP 补合 | ✅ 已合并 | `tools/feishu_push/` 真正到 main |
| #18 · monitor_lib_parity_ci spec | ✅ 已合并 | P2 CI 防护 spec |
| #19 · monitor_lib_shared Python 版 + CI | ✅ 已合并 | 数据 Agent 核心交付 |

---

## 已知阻塞

1. **category_rules 初始值** — 需要业务方 review 阈值，否则 `category_weekly_monitor` 无法上线
2. ~~**飞书推送凭据** — 走 **App 模式**~~ **✅ 已解**：`tools/feishu_push/send_card.py` MVP 完成（PR #14），双通道 + 三级降级 + 30KB 保护 + LARK_CLI_CMD 环境变量桥接。zz-server → AI分析群真发验证通过（message_id `om_x100b6bbf17bc30a4c2d27b5c9f8a4bd`，一次成功没走降级）。截图证据在 `docs/screenshots/feishu-card-monitor-weekly-w27.png`。**遗留**：(a) `orchestrator/lib/monitor/pusher.py` 薄封装等 monitor spec 实施时接入；(b) 4 个业务群 webhook 到位后补自定义机器人通道真发验证（代码就绪）
3. **zz-server model-tag-monitor wave.js calcTrend 显式 null 填充**（Issue #21）— 3.4% pool item trend 返回 `{}` 违反契约。前端 Agent 已加 `normalizeTrend` 归一化兜底，不阻塞前端；Python 版正确，不影响未来接管。**优先级 P1**，等有 SSH 的时机（用户 / ai数据导入 Agent HiNet 解阻塞后）修 5 行代码
3. **spawn_agent 稳定用法** — 数据 Agent `agent_hook.py` 真实版阻塞项；主控代查 event_handler 那边（2026-07-04 主控接手）
4. **飞书多维表格接入** — 数据 Agent `fetcher.py` 真实版阻塞项：需要 `app_token / table_id / 字段映射`；只能用户给（涉及具体飞书表 URL 和字段对应关系）
5. **服务器 SSH 通路** — 台湾 HiNet 通不了 `47.84.94.234`；主控 `curl` 直接 HTTP 访问 `:8848` 端点可用，作为影子模式期间的备用回退路径
6. **性能 tech debt**（不紧急）— 现役 `/api/data` 62MB、`/api/monitor` 2.8MB，前端全量下载；influenced dashboard 加载慢，v2 时分页/增量

---

## 完整任务清单

按建议实施顺序：

- [ ] 合并 `feature/monitor-specs` 到 main
- [ ] 业务方 review `category_rules.json` 阈值
- [ ] 开 3 个飞书群 webhook（机型/品类/项目状态）
- [ ] 实施 `monitor_lib_shared`（5.5 天）
- [ ] 实施 `model_weekly_monitor`（4.5 天）
- [ ] 数据一致性校验：Python 输出 vs 现 Node 输出误差 < 0.5%
- [ ] 上线 `model_weekly_monitor` cron，试跑 2 周
- [ ] 实施 `category_weekly_monitor`（2 天，串行）
- [ ] 重新规划 dashboard 前端（作为 monitor skill 输出面板之一）
- [ ] 恢复 PR #12 或重开新 PR
- [ ] 实施 `project_status`（3.5 天，可并行）
- [ ] 老 `model-tag-monitor` 的 wave/rules 逻辑下线，Node 侧只留静态资源

---

## 决策记录（本次会话敲定）

1. **model-tag-monitor 归宿** = 重构成 daily_analyst 的 skill
2. **Skill 粒度** = 两个 skill + 共享 lib
3. **AI 归因位置** = 写在 workflow 里，spawn_agent 判断
4. **触发方式** = cron 周自动（+ 手动 @）
5. **项目仪表盘** = 新 skill `project_status` 自动生成
6. **规则管理入口** = 服务器现役 dashboard (`http://47.84.94.234:8848/`) **已有"规则配置" tab + `GET/PUT /api/rules` 端点**；任务不是"新加 tab"，而是"确保 Python 侧 monitor_lib_shared 输出的规则 shape 跟现役 `/api/rules` 五字段（`poolTopN/poolMinWeek/waveThreshold/trendWeeks/minEvaUv` + `rates[]`）严格一致"（2026-07-04 主控从服务器现场核对）
7. **数据契约 v1.0 固化** = 数据 Agent `docs/superpowers/handoffs/data_to_frontend_contract.md` 契约跟服务器 `/api/monitor` 现役 shape 100% 匹配（顶层 keys/pool item 24 字段/delta 5 转化率/trend up|down|null 语义，全 camelCase）→ 契约 v1.0 生效（2026-07-04 主控核对）
8. **前端接入走影子模式（路径 A）** = Python 端先写 `cache.python.json`，Node 版继续写 `cache.json`；diff = 0 后切换到 Python 主写。前端 REST 端点零改动、字段命名零改动。B 路径（Python 直接 serve API + 前端改 fetch URL）作为中期目标，不本周做（2026-07-04 主控与用户讨论）
9. **凭据管理铁律**（项目组共识）= App Secret / 私钥 / Token 等敏感凭据**禁止**出现在聊天消息、代码、环境变量、commit、日志里。仅存在于服务器 `/root/.lark-channel/` 加密 keystore；取用必须通过 `lark-channel-bridge secrets get` 的 stdin JSON 协议（`{protocolVersion:1, provider:"bridge", ids:[...]}`）。所有 sub-agent 一律遵守（2026-07-04 主控 + 用户确认，来源：数据 Agent phase1 handoff）
10. **服务器接入通路** = SSH 私钥仅在用户 Mac 上（`~/.ssh/id_ed25519`，Port 443 / User admin），别 agent 不共享。**所有 sub-agent 通过 8848 HTTP API 消费真实数据**（`GET /api/data` / `GET /api/monitor` 等），不各自 SSH。这是分工也是安全设计（2026-07-04 主控 + 数据 Agent 共识）

---

## 活跃 sub-agent 分工（CCD sessions）

| Session | 职责（2026-07-04 修正） | 关联产物 | 状态 |
|---|---|---|---|
| 项目主控 agent（本文件维护者） | 全局协调、维护 PROJECT_STATUS、对齐 sub-agent、契约裁决 | `feature/monitor-specs` | 在岗 |
| ai数据呈现（数据 Agent） | 已交付 `monitor_lib_shared` Python 版（wave/rules/schemas + fetcher/agent_hook/pusher/cli end-to-end mock）+ 真实生产数据 10 品类等价性验证 + CI workflow | ✅ PR #19 合入 main | **收工**；等 fetcher HTTP 真实版任务派发时激活 |
| 页面交互UI优化agent（前端 Agent） | 实施 dashboard 代码（下钻链路 + 消费 Python 版 `cache.json`） | PR #12 / `feature/dashboard-drilldown`（stash 已还原，1802 行工作树完好） | 待命，等契约同步 |
| ai数据导入 | 飞书 base pipeline（`_cells_clear_retry`/`auto-shrink`/`max_row` 补丁堆积中）；主控已发根治建议（append-only / upsert by week） | 上游数据管道 | 处理主控诊断中；台湾 HiNet 通不了 SSH 阻塞真实调试 |
| 飞书推送 Agent 引导 | ✅ 已完成 MVP：`tools/feishu_push/send_card.py` 双通道三级降级 + 3 卡片模板 + 17 单测 + AI分析群真发验证 | PR #14 → 补合 #17 到 main | **收工**；下次 monitor spec 实施 pusher.py 薄封装时激活 |

主控对 sub-agent 的原则：不越权抢活，只做对齐/传话/记账；有决策变更时主动同步到相关 session。

---

## 下一次会话建议聚焦

择一：

- **A. 开工 monitor_lib_shared**（进入实施，产出可跑代码）
- **B. 先解阻塞**（找业务方确认 category rules；开飞书 webhook）
- **C. 先做 project_status**（跳过 monitor 主线，先把主控看板搭起来）

推荐 B → A 的顺序。B 是低耗时的沟通工作，可以并行给别人推进；A 是主线代码，需要专注时段。
