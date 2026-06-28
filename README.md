# ZZ-AI-Business-Analysis

转转回收业务·多 Agent 数据分析工作流。

## 架构

```
品类运营同学（飞书 @机器人）
        ↓
   主 Agent（编排层）
        ↓ 路由分发
┌───────┬───────┬───────┐
↓       ↓       ↓
专家A   专家B   专家C
日常    用户    诊断
分析    分析    核验
└───────┴───────┴───────┘
     ↓ 共享调用
   通用能力层（MCP 原子工具）
     ↓ 共享查询
   知识库层（指标口径/框架/案例/基线）
```

## 技术栈

- **Agent 运行时**：OpenAI Codex CLI（中转站 v2.qixuw.com）
- **编排层**：Python 3.11 + FastAPI
- **工具协议**：MCP (Model Context Protocol)
- **数据接入**：腾讯企业邮箱 IMAP 收 CSV 附件
- **输出通道**：飞书 lark-cli（文档/IM/Wiki）

## 目录

- `principles/` — 原则层（所有 Agent 继承）
- `experts/` — 3 个专家 Agent 配置（AGENTS.md + skills）
- `mcp_servers/` — 通用能力层 MCP servers
- `orchestrator/` — 主 Agent + 飞书 webhook 入口
- `knowledge/` — 知识库内容
- `scripts/` — 部署/测试脚本

## 部署

见 `scripts/setup.sh`。

## 当前进度

- [x] 服务器环境
- [x] Codex / lark-cli 接入
- [ ] MVP-1：专家 A 日常分析师 + 周报 Skill
- [ ] MVP-2：完整 3 专家 + 飞书 webhook
- [ ] MVP-3：定时任务 + 监控
