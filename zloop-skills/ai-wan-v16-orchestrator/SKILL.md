---
name: AI小万主编排 v1.6
description: AI 小万 v1.6 单 Loop 入口 Skill：只做流程编排，通过 $ 调用数据读取、数据处理、经营分析、结果校验四个阶段 Skill，并用 APIHub 读写桥检查 checkpoint。
version: 1.6.0
---

# AI小万主编排 v1.6

## Loop 入口约束

zloop Loop 当前只能选择一个 Skill，因此生产 Loop 必须选择本 Skill。其他阶段 Skill 不直接挂到 Loop 上，而由本 Skill通过 `$` 显式调用。

必须按固定顺序执行：

```text
read → process → analyze → validate
```

## 允许参数

```json
{
  "run_id": "2026-W28-weekly",
  "week": "2026-W28",
  "start_stage": "read",
  "end_stage": "validate",
  "scope": { "type": "weekly", "category": null },
  "rerun": false,
  "rerun_reason": ""
}
```

未提供 `run_id` 时使用 `<week>-weekly`。未提供 `start_stage/end_stage` 时完整执行四阶段。

## 编排规则

每个阶段执行前：

1. 调用 APIHub 读接口 `/api/aiwan/read`，读取 `run_meta` 与 `previous_stage_outputs`。
2. 如果该阶段已成功且 `rerun=false`，跳过该阶段。
3. 如果需要执行，则通过 `$` 调用对应阶段 Skill。
4. 阶段 Skill 必须自己写回 `/api/aiwan/write`。
5. 本 Skill 再调用 `/api/aiwan/read` 确认阶段 checkpoint 成功。
6. 任一阶段失败，停止后续阶段，并要求失败阶段已经写入 `status=failed`。

## 阶段调用

必须按以下名字调用：

```text
$AI小万数据读取 v1.6
$AI小万数据处理 v1.6
$AI小万经营分析 v1.6
$AI小万结果校验 v1.6
```

传给阶段 Skill 的输入必须只包含 `run_id/week/stage/scope/rerun/rerun_reason`，不得把上一阶段大段结果直接粘进上下文。


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


