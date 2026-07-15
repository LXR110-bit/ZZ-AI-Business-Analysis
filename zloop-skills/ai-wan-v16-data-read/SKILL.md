---
name: AI小万数据读取 v1.6
description: AI 小万 v1.6 read 阶段 Skill：通过 APIHub 读取旧服务器数据状态、近 10 周窗口和 source readiness，生成 read checkpoint；可被主编排 Skill $ 调用，也可手动单独重跑。
version: 1.6.0
---

# AI小万数据读取 v1.6

## 职责

本 Skill 只负责 `read` 阶段：

```text
读取旧服务器已有数据状态
确认 week、history_weeks、source readiness
生成本轮上下文索引
写 read 阶段 checkpoint
```

不得生成经营洞察，不得调用 LLM 做归因。

## 执行步骤

1. 使用 `run_id/week/scope` 调用 `/api/aiwan/read`，`stage=read`。
2. include 至少包含：`run_meta`、`history_10w`、`metric_snapshot`、`rules`。
3. 检查：目标周存在、历史窗口存在、dashboard/context 可读取。
4. 写回 `/api/aiwan/write`：
   - `stage=read`
   - `status=success|warn|failed`
   - `output_type=read_context`
   - `payload.history_weeks`、`payload.source_readiness`、`payload.context_summary`

失败时也必须写回 failed checkpoint。


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


