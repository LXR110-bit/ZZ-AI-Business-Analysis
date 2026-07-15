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
