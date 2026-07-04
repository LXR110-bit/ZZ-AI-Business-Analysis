# PROJECT_STATUS

> 项目主控视图。初版由人工维护，`project_status` skill 上线后 AI 自动接管。
> 最后更新：2025-07-04 · 手工

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
| monitor_lib_shared | 📝 定稿待启动 | P0 | 无 | 5.5 天 | W28 |
| model_weekly_monitor | 📝 定稿待启动 | P1 | monitor_lib_shared | 4.5 天 | W28-W29 |
| category_weekly_monitor | 📝 定稿待启动 | P1 | monitor_lib_shared + rules 业务确认 | 2 天 | W29-W30 |
| project_status | 📝 定稿待启动 | P2 | 无 | 3.5 天 | 可并行 |

Spec 全文见 [`docs/superpowers/specs/`](./docs/superpowers/specs/)。

---

## 关联 PR

| PR | 状态 | 说明 |
|---|---|---|
| [#12 · dashboard 下钻链路](https://github.com/LXR110-bit/ZZ-AI-Business-Analysis/pull/12) | ⏸ 暂缓 | 前端下钻交互，等 monitor skill 落地后重新规划输出面板 |
| `feature/monitor-specs` (本分支) | 🟢 待合并 | 本次 4 份 spec |

---

## 已知阻塞

1. **category_rules 初始值** — 需要业务方 review 阈值，否则 `category_weekly_monitor` 无法上线
2. **飞书群 webhook** — 机型/品类/项目状态各需一个独立群或独立 bot，尚未开通
3. **spawn_agent 稳定性** — v0.4 实施中，`monitor_lib_shared` 联调时需确认接口冻结

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

---

## 下一次会话建议聚焦

择一：

- **A. 开工 monitor_lib_shared**（进入实施，产出可跑代码）
- **B. 先解阻塞**（找业务方确认 category rules；开飞书 webhook）
- **C. 先做 project_status**（跳过 monitor 主线，先把主控看板搭起来）

推荐 B → A 的顺序。B 是低耗时的沟通工作，可以并行给别人推进；A 是主线代码，需要专注时段。
