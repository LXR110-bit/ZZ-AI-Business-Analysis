# AI小万 v1.6.2 Validate APIHub 最终写入契约

## 边界

本阶段负责最终写服务器：

- 输入：`processed_data` + `analysis_result`。
- 校验后生成 `validation_result`。
- 通过 APIHub write 写入最终数据和分析结果。
- 写入后通过 APIHub read 复读确认。

禁止重新跑 SQL、重做 process、重写 analyze 结论。

## Runtime Client Gate

- 唯一 runtime client：`zloop_runtime.hub`。
- 只允许相对 path `/v2/aiwan/api/aiwan/write` 和 `/v2/aiwan/api/aiwan/read`。
- 禁止 `/gw/`、完整网关域名、Authorization、APIHub token、自定义上游凭证头。

## Write 请求

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

## 复读确认

写入成功后 read `stage=validate`，确认：

- `run_meta.stages.validate` 或等价返回中存在 validate 结果；
- `status/output_type/revision` 与写入响应一致；
- `run_id/week` 未漂移。

## run_id 规范

后端只允许 `run_id` 包含：`0-9 A-Z a-z . _ : -`；`+0800` 必须改成 `_0800`。
