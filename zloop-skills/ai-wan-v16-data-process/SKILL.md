---
name: AI小万数据处理 v1.6
description: AI 小万 v1.6 process 阶段 Skill：通过 APIHub 复用旧服务器聚合结果，生成 metric_snapshot 与 candidate_anomalies，并写 process 阶段结果。
version: 1.6.0
---

# AI小万数据处理 v1.6

## 职责

本 Skill 只负责 `process` 阶段：

```text
复用旧服务已有聚合能力
确认大盘、品类簇、品类、机型基础指标
生成 metric snapshot
生成 candidate anomalies
写 process 阶段结果
```

不得重新跑 Hive SQL，不得重做旧服务器同步脚本，不得生成 AI 归因结论。

## 执行步骤

1. 调用 `/api/aiwan/read`，`stage=process`。
2. include 必须包含：`run_meta`、`metric_snapshot`、`candidate_anomalies`、`previous_stage_outputs`。
3. 如果缺少 read 阶段输出，停止并写 `status=failed`。
4. 对候选异常只做确定性整理：排序、去重、补充 scope 信息。
5. 写回 `/api/aiwan/write`：
   - `stage=process`
   - `output_type=metric_snapshot`
   - `payload.metric_snapshot`
   - `payload.candidate_anomalies`
   - `payload.process_summary`


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


