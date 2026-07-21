# AI小万 v1.6.2 APIHub 使用边界

## Runtime Client Gate

- 唯一 runtime client：`zloop_runtime.hub`。
- Python 只允许 `import zloop_runtime.hub as hub`。
- 只传 APIHub v2 相对 path：`/v2/aiwan/api/aiwan/read`、`/v2/aiwan/api/aiwan/write`。
- 禁止手拼 `/gw/`、网关域名、Authorization、APIHub token 或自定义上游凭证头。

## 阶段边界

APIHub 不再是每阶段 checkpoint 中心：

| 阶段 | APIHub 使用 |
|---|---|
| read | 禁止读写服务器；只跑 SQL |
| process | 禁止读写服务器；只按模板处理 read_result |
| analyze | 只允许读取服务器上下文 |
| validate | 校验后最终写入服务器，并复读确认 |

## run_id 规范

后端只允许 `run_id` 包含：`0-9 A-Z a-z . _ : -`。

- `+0800` 必须规范化为 `_0800`。
- 规范化后的 `run_id` 必须贯穿四阶段。

## Analyze read

分析阶段读取服务器上下文：

```bash
python scripts/aiwan_apihub.py read \
  --run-id "$RUN_ID" \
  --stage analyze \
  --week "$WEEK" \
  --history-weeks 10 \
  --include run_meta,history_10w,model_history,previous_model_drilldowns,rules,loop2_context_meta,previous_stage_outputs
```

Read 请求只允许 schema 字段：`run_id`、`stage`、`week`、`include`、`history_weeks`、`model_history_filters`。

- `history_10w` 仅返回周列表、缓存来源、行数等汇总元数据，不得当作机型趋势明细。
- `model_history` 返回近 10 周内按 `model_history_filters.categories` 和 `model_history_filters.model_ids/model_names` 过滤后的机型历史行；服务端必须做字段白名单、10 周上限和行数上限。
- `previous_model_drilldowns` 只作为上一期结论上下文，不能覆盖本期 SQL 数字。
- `loop2_context_meta` 返回规则版本、核心机型快照版本、base revision、analysis_key、data_end_date 等版本对齐信息。

## Validate final write

校验阶段最终写入服务器，payload 必须包含：

- `processed_data`
- `analysis_result`
- `validation_result`

```json
{
  "run_id": "<same-run-id>",
  "week": "2026-W29",
  "stage": "validate",
  "status": "success|warn|failed",
  "output_type": "validation_result",
  "payload": {
    "processed_data": {},
    "analysis_result": {},
    "validation_result": {}
  },
  "warnings": [],
  "artifacts": []
}
```

写入后必须 read `stage=validate` 复读，确认 validate 结果已经持久化。
