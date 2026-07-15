---
name: AI小万结果校验 v1.6
description: AI 小万 v1.6 validate 阶段 Skill：校验 analyze 输出 schema、证据链、置信度、强结论风险和页面/飞书可消费性，并写 validate 结果。
version: 1.6.0
---

# AI小万结果校验 v1.6

## 职责

本 Skill 只负责 `validate` 阶段：

```text
校验 schema
校验证据链
校验 confidence
校验是否有无依据强结论
校验页面/飞书可消费性
写 validate 阶段结果
```

不得重写 analyze 结论。需要语义复核时，只能标记问题和建议重跑 analyze。

## 必检规则

- `payload.findings` 必须是数组。
- 每条 finding 必须有 `level/entity_type/entity_name/metric/direction/severity/confidence`。
- `confidence` 只能是 `high|medium|low`。
- 每条 finding 必须有非空 `evidence` 或明确 `data_warnings`。
- 不允许出现无数据依据的强业务结论。
- 不允许直接给“调价/补贴/投放”等强策略动作；只能给下钻方向。
- 页面/飞书消费字段必须可序列化。

## 执行步骤

1. 调用 `/api/aiwan/read`，`stage=validate`。
2. include 必须包含：`previous_stage_outputs`。
3. 如果缺少 analyze 输出，写 failed checkpoint。
4. 输出 `validation_report` 和 `final_status`。
5. 写回 `/api/aiwan/write`：
   - `stage=validate`
   - `output_type=validation_result`
   - `status=success|warn|failed`


## APIHub 读写桥契约

所有 v1.6 Skill 必须把服务器/APIHub 当作唯一状态中心，禁止依赖上一阶段的聊天上下文或临时口头结论。

### 统一读接口

`POST /api/aiwan/read`

必传：

```json
{
  "run_id": "2026-W28-weekly",
  "stage": "analyze",
  "week": "2026-W28",
  "scope": { "type": "weekly", "category": null },
  "include": ["run_meta", "history_10w", "metric_snapshot", "candidate_anomalies", "rules", "previous_stage_outputs"]
}
```

### 统一写接口

`POST /api/aiwan/write`

必传：

```json
{
  "run_id": "2026-W28-weekly",
  "stage": "analyze",
  "status": "success",
  "output_type": "analysis_result",
  "payload": {},
  "warnings": [],
  "started_at": "",
  "finished_at": ""
}
```

### 阶段名

只使用以下阶段名：`read`、`process`、`analyze`、`validate`。

每个阶段成功、失败、跳过都必须写回 `/api/aiwan/write`。失败时 `status=failed`，`payload.error` 必须说明失败原因和可重跑建议。


