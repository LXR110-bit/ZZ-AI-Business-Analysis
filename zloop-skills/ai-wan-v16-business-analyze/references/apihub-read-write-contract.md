# AI小万 v1.6.5 Analyze APIHub 只读契约

## 边界

本阶段是四阶段中唯一读取服务器上下文的分析阶段。

- 输入主数据来自 `processed_data`。
- APIHub read 只用于补充服务器上下文、历史窗口、规则、标签知识和已有配置。
- 禁止写服务器；最终写入只由 `AI小万结果校验 v1.6` 完成。

## Runtime Client Gate

- 唯一 runtime client：`zloop_runtime.hub`。
- 只允许相对 path `/v2/aiwan/api/aiwan/read`。
- 禁止 `/gw/`、完整网关域名、Authorization、APIHub token、自定义上游凭证头。
- 本包脚本为 read-only；不得在 analyze 阶段调用 write。

## Read 请求

```bash
python scripts/aiwan_apihub.py read \
  --run-id "$RUN_ID" \
  --stage analyze \
  --week "$WEEK" \
  --history-weeks 10 \
  --include run_meta,history_10w,rules,previous_stage_outputs
```

只允许发送：`run_id`、`stage`、`week`、`include`、`history_weeks`。

## 期望 server_context

read 响应中可消费的上下文包括：

```json
{
  "ok": true,
  "run_id": "",
  "stage": "analyze",
  "context": {
    "run_meta": {},
    "history_10w": {},
    "rules": {},
    "previous_stage_outputs": {},
    "model_tag_knowledge": {}
  },
  "warnings": []
}
```

字段缺失时不得补造；必须在 `evidence_pack.known_gaps` 与 `analysis_result.warnings` 记录。

## run_id 规范

后端只允许 `run_id` 包含：`0-9 A-Z a-z . _ : -`；`+0800` 必须改成 `_0800`。
