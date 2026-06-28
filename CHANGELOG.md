# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号遵循 [SemVer](VERSIONING.md)。

## [Unreleased]

### Added
- `CONTRIBUTING.md` — 完整贡献指南（分支 / commit / PR / 多 Agent 协作）
- `VERSIONING.md` — 语义化版本 + 发版流程
- `.github/PULL_REQUEST_TEMPLATE.md` — PR 模板
- `.github/CODEOWNERS` — 代码 owner 规则
- `.agent-locks/` — Agent 协作锁机制

## [0.1.0] - 2026-06-28

### Added
- **MVP-1 完成**：单 Agent + 周报 Skill 全链路打通
- **基础设施**：
  - 阿里云轻量服务器（新加坡 2C4G）
  - 系统加固：ufw / fail2ban / 禁密码登录 / 4G swap
  - 运行时：Docker / Node 20 / Python 3.11 / uv
- **AI 接入**：
  - Codex CLI 0.142.3 + 中转站 v2.qixuw.com (gpt-5.5)
  - lark-cli 1.0.59 + 飞书自建 app `cli_aab4e49b7bb95bd3`
- **原则层** `principles/core.md`（9 节）：
  - §1 三层穿透 / §2 生命周期×阈值 / §3 价值链瓶颈
  - §4 异动诊断四问 / §5 动作闭环
  - §6 输出自检 / §7 严谨性 / §8 沟通 / §9 协作
- **专家层**：
  - 专家 A 日常分析师（完整）
  - 专家 B 用户分析师（stub）
  - 专家 C 诊断核验师（stub）
  - 6 个 Skill 文件（周报完整、其余 stub）
- **MCP servers**：
  - `data_tools`：IMAP 读邮件、CSV 解析、维度拆解、口径计算、框架匹配、案例查询
  - `lark_tools`：飞书 IM、文档创建、wiki 读取
  - `knowledge_base`：指标口径查询、框架查询、基线查询
- **编排层** `orchestrator/`：
  - CLI 入口（`python -m orchestrator <问题>`）
  - FastAPI webhook 入口（MVP-2 完整化）
  - 关键词路由（MVP-2 升级到 LLM 路由）
- **知识库**：
  - `knowledge/metrics_dictionary.md` v0 初始版（10 个核心指标口径）

### Known Issues
- 飞书 wiki 知识库需要 bot 加为成员才能读取（v0.2.0 解决）
- 飞书 docs 创建后 owner 是 bot，需要 transfer_doc_owner 转给用户（v0.2.0 实现）
- agent-data 邮件文件夹 IMAP 暂不可见（用户邮箱设置同步问题）

### 历史里程碑
- 2026-06-28：项目启动，规划架构、采购服务器
- 2026-06-28：MVP-1 完成、v0.1.0 发布
