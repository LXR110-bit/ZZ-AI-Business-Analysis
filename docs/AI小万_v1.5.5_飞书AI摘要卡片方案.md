# AI 小万 v1.5.5 飞书 AI 摘要卡片方案

## 目标

v1.5.5 先补齐“服务器主动读取 zloop 产物 → 生成飞书 AI 经营摘要卡 payload → 质量校验 → dry-run/outbox 渲染”的最小闭环，不改变现有 `monitor_weekly` 正式推送链路。

首版只允许：

- 服务器通过旁路脚本主动拉取 / 复制 zloop 产物到本地 run workspace；
- 从本地文件读取 zloop 产物；
- 生成 `ai_business_summary` payload；
- 用 checker 阻断字段泄漏、URL 异常和正式推送误开启；
- 用 `send_card.py --dry-run` 渲染到 outbox。

首版不做：

- 不修改 `model-tag-monitor/scripts/refresh-dashboard-daily.sh` 的正式推送逻辑；
- 不复用 `monitor_weekly` 模板推 AI 摘要；
- 不自动发布 dashboard；
- 不对真实飞书群正式发送 AI 摘要卡。

## 新增接口

### 0. 服务器旁路 dry-run 入口

```bash
model-tag-monitor/scripts/render-ai-business-summary-dry-run.sh \
  --source-dir /root/workspace/ai-wan-zloop-artifacts/YYYY-MM-DD \
  --run-dt YYYY-MM-DD \
  --report-url https://example.com/zloop-artifact-or-report \
  --dashboard-url https://example.com/dashboard \
  --outbox-dir tools/feishu_push/outbox
```

该脚本是 v1.5.5 的服务器接入入口，执行顺序固定为：

1. 从 `--source-dir` 复制 zloop 产物到 `model-tag-monitor/logs/ai-business-summary/<RUN_ID>/artifacts/`；
2. 运行 `build-ai-business-card-payload.js` 生成 `ai_business_summary` payload；
3. 运行 `check-ai-business-card-payload.js` 做质量校验；
4. 调用 `send_card.py --template ai_business_summary --dry-run` 写 outbox。

主动拉取有两种接入方式：

- **目录模式**：zloop 或同步任务先把 `insights.json`、`summary.md`、`final_status.json`、`validation_report.json` 放到 `--source-dir`，脚本负责复制到本次 workspace。
- **Hook 模式**：设置 `ZLOOP_ARTIFACT_PULL_CMD`，脚本会导出 `RUN_DT` 和 `ARTIFACT_DIR` 后执行该命令；该命令必须把 `insights.json` 写入 `ARTIFACT_DIR`，其余三个文件可选。

硬约束：脚本永远只传 `--dry-run`，且不会向 `send_card.py` 传 `--chat-id` / `--webhook-url` / `--open-id`；因此即使服务器上存在飞书收件人环境变量，AI 摘要卡也只会落 outbox，不会正式推送。

### 1. Payload builder

```bash
node model-tag-monitor/scripts/build-ai-business-card-payload.js \
  --insights /path/to/insights.json \
  --summary /path/to/summary.md \
  --final-status /path/to/final_status.json \
  --validation-report /path/to/validation_report.json \
  --report-url https://example.com/zloop-artifact-or-report \
  --dashboard-url https://example.com/dashboard \
  --out /tmp/ai-business-card-payload.json
```

必填：

- `--insights`：zloop 分析阶段输出的 `insights.json`；
- `--out`：写出的飞书卡 payload。

可选：

- `--summary`：`summary.md`，用于优先提取大盘 / 品类 / 机型 / 履约四层摘要；
- `--final-status`：`final_status.json`，用于读取 pass/warn/failed、publish_allowed、push_allowed 与 known_gaps；
- `--validation-report`：`validation_report.json`，用于补充 known_gaps；
- `--report-url` / `--dashboard-url` / `--zloop-url`：卡片按钮 URL；
- `--run-dt`：覆盖 run_dt；
- `--generated-at`：测试或回放时固定生成时间。

输出 payload 关键字段：

```json
{
  "schema_version": "ai_business_summary.v1",
  "card_type": "ai_business_summary",
  "dry_run_only": true,
  "run_dt": "YYYY-MM-DD",
  "four_layer_summary": {
    "overall": "大盘摘要",
    "category": "品类摘要",
    "model": "机型摘要",
    "fulfillment": "履约摘要"
  },
  "top_findings": [],
  "action_items": [],
  "known_gaps": [],
  "validation": {
    "overall_status": "pass|warn|failed",
    "data_status": "pass|warn|failed",
    "analysis_status": "pass|warn|failed",
    "publish_allowed": false,
    "push_allowed": false
  }
}
```

### 2. Payload checker

```bash
node model-tag-monitor/scripts/check-ai-business-card-payload.js \
  --payload /tmp/ai-business-card-payload.json \
  --run-dt YYYY-MM-DD \
  --out /tmp/ai-business-card-quality.json
```

校验项：

- payload 顶层 schema 与 `card_type=ai_business_summary`；
- `dry_run_only=true`；
- 四层摘要必须包含大盘 / 品类 / 机型 / 履约；
- `top_findings` 至多 6 条，且每条包含层级、对象、指标、结论、证据与建议；
- `known_gaps` 必须显式存在，即使没有缺口也要说明“暂无新增已知缺口”；
- `report_url` / `dashboard_url` 必须是 http(s)；
- `validation.publish_allowed` 与 `validation.push_allowed` 在 v1.5.5 必须不是 `true`；
- 禁止业务可见文本泄漏技术字段，例如 `orderRate`、`dealCnt`、`gmv`、`evidence_id`、`model_trace`、`board_metrics_feishu.csv`、`SQL`、`LLM` 等。

失败退出码为 `10`，用于流水线阻断。

### 3. 飞书模板

新增模板：

- `tools/feishu_push/card_templates/ai_business_summary.json`
- `tools/feishu_push/card_templates/ai_business_summary_finding_item.json`
- `tools/feishu_push/card_templates/ai_business_summary_action_item.json`
- `tools/feishu_push/card_templates/ai_business_summary_gap_item.json`

渲染命令：

```bash
python3 tools/feishu_push/send_card.py \
  --template ai_business_summary \
  --payload /tmp/ai-business-card-payload.json \
  --dry-run \
  --outbox-dir tools/feishu_push/outbox
```

> 注意：v1.5.5 只使用 `--dry-run`。不要给 AI 摘要卡配置真实 `--chat-id` / `--webhook-url` 后正式发送。

## 与现有 daily refresh 的关系

现有 `model-tag-monitor/scripts/refresh-dashboard-daily.sh` 仍然只生成并推送 `monitor_weekly`：

```text
build-weekly-card-payload.js → check-card-payload.js → send_card.py --template monitor_weekly
```

v1.5.5 新增链路是旁路 dry-run：

```text
zloop artifacts(insights/summary/final_status/validation_report)
  → render-ai-business-summary-dry-run.sh(pull/copy sidecar)
  → build-ai-business-card-payload.js
  → check-ai-business-card-payload.js
  → send_card.py --template ai_business_summary --dry-run
  → outbox
```

因此不会影响旧周报正式推送。

## 建议集成步骤

1. 服务器拉取或读取最新 zloop 产物到本地稳定目录，例如：

   ```text
   /root/workspace/ai-wan-zloop-artifacts/<run_dt>/insights.json
   /root/workspace/ai-wan-zloop-artifacts/<run_dt>/summary.md
   /root/workspace/ai-wan-zloop-artifacts/<run_dt>/final_status.json
   /root/workspace/ai-wan-zloop-artifacts/<run_dt>/validation_report.json
   ```

2. 独立 cron 或手工任务执行 `render-ai-business-summary-dry-run.sh`；如 zloop 产物不在本机目录，则用 `ZLOOP_ARTIFACT_PULL_CMD` 接入拉取命令。
3. 脚本内置执行 builder + checker，checker 通过后自动执行 `send_card.py --dry-run` 写 outbox。
4. 人工 review outbox 卡片内容，确认业务文案、四层摘要、known_gaps 和按钮 URL。
5. 后续版本若要正式推送，先增加 feature flag，例如 `AI_BUSINESS_CARD_SEND_ENABLED=1`，并保留 checker 对 `push_allowed` 的硬阻断条件。

## 风险与边界

- 如果 zloop `summary.md` 标题不含“大盘/品类/机型/履约”，builder 会回退到 `insights.json` 分层洞察；仍缺失时会写入“未识别到明确异常”的保守摘要。
- 当前 `send_card.py` 的 fallback 文案仍偏 `monitor_weekly`，因此 AI 摘要卡首版只使用 dry-run 卡片渲染，不依赖 fallback 正式发送。
- `known_gaps` 会将 `board_metrics_feishu.csv pending` 等技术表达转成“大盘流量指标待接入”，避免飞书业务卡暴露内部文件名。
