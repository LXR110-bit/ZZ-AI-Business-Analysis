# Changelog

## 2026-07-16

- **model-tag-monitor v1.6.0 APIHub/zloop 多阶段桥接**：新增 `/api/aiwan/read` 与 `/api/aiwan/write` 统一读写接口，以 `run_id + stage` 管理 `read/process/analyze/validate` 阶段状态；阶段结果落盘到 `data/aiwan-runs/{run_id}/`，支持 revision 覆盖策略、旧 dashboard/context/history/rules 封装和 previous stage 校验。
- **AI 小万 v1.6 zloop Skill 拓扑**：新增单 Loop 入口主编排 Skill 与四个独立阶段 Skill（数据读取、数据处理、经营分析、结果校验），主 Skill 通过 `$` 调用阶段 Skill，阶段间只通过 APIHub/server state 传递。
- **生产部署口径**：显式要求生产 `ACCESS_CODE`，避免硬编码门禁码；proxy 模式排除 `/api/aiwan/read` 与 `/api/aiwan/write`，确保本地桥接接口不被转发到旧上游。

## 2026-07-10

- **model-tag-monitor v1.4.7 日更产物保留策略**：日更链路启动时自动清理超过 `ARTIFACT_RETENTION_DAYS`（默认 30 天）的 local-imports、运行日志、覆盖校验文件、卡片 payload、源附件 cache 和 dry-run outbox，避免 50GB 生产盘被历史日更产物打满；支持 `ARTIFACT_CLEANUP_ENABLED=0` 关闭和 `ARTIFACT_CLEANUP_DRY_RUN=1` 演练。

## 2026-07-10

- **model-tag-monitor v1.4.6 日更时点与重试保护**：生产日更改为 06:50 执行；数据准备阶段新增 `DATA_READY_MAX_ATTEMPTS` / `DATA_READY_RETRY_SECONDS`，local-import 或覆盖校验失败时先重试，所有尝试失败后才发送飞书预警，仍保持不覆盖页面、不生成 AI、不推送经营卡片。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号遵循 [SemVer](VERSIONING.md)。

## [Unreleased]

### Fixed
- **model-tag-monitor v1.4.5 日滚动链路修复**：06:30 刷新改为先跑 local-imports 并校验本次 run/目标周 `day_cnt` 覆盖，校验通过后才同步页面、生成 AI、推送卡片；失败时发送飞书预警并保留上一成功页面数据。
- **生产邮件导入稳健性**：兼容腾讯企业邮箱附件名重复拼接、IMAP 大附件正文偶发空响应；附件下载增加 fetch retry 和重连 retry。
- **local-import 最新周过滤**：模型 zip 分片中同时包含上周/本周时，按源表最新 `week_start_date` 过滤后再归月写入，避免模型维度 W28 数据因首行 W27 被误判到 6 月。

### Changed
- **knowledge_base MCP 实接飞书 base**（不再读本地 stub）：`query_metric/query_field/query_dim_value/query_table` 4 个工具直查 4 张表（base_token N6OVb2qz5aKxf9sY9kRc7y6onYd）。bot 身份调用，已实测可读。git 里 `knowledge/metrics_dictionary.md` 弃用（飞书是 source of truth）。
- `get_baseline` 仍是 stub（飞书 base 暂未建品类基线表）。


### Added
- **event_handler 接入 Review Gate**：agent 输出前过 critic 审查；FAIL 自动让 expert 带 issues 重写（默认最多 2 次重试，env `MAX_REVIEW_RETRIES`）。飞书回复尾部附 `— review✓` 或 `⚠ review 未过` + issue 列表。Review Gate 未装时 graceful degrade（跳过审查不阻塞）。


### Added
- **Review Gate 层**：独立 `review_gate/` package，对抗审查 agent 输出。强制走 §6 自检 6 项（§1/§2/§3/§4/§5/§7）。模型 gpt-5.5。CLI: `python -m review_gate --task ... --output @file --principles principles/core.md`。退出码 0=PASS / 1=FAIL。


### Added
- ✅ GitHub main 分支保护规则上线（Require PR + 1 approval + linear history + dismiss stale approval + Code Owners + 不许 bypass）
- ✅ Fine-grained PAT 接入，agent 可自动开 PR
- 演示工作流：agent 在 agent-claude/* 分支提交 → 自动 gh pr create → 人工 review + squash merge

(此条会在合并到 main 后归到下一个版本)


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
