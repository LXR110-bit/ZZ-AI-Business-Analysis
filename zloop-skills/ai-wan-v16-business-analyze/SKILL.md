---
name: AI小万经营分析 v1.6
description: AI 小万 v1.6 analyze 阶段 Skill：读取 process 结果、近 10 周历史和规则，生成数据证据支持的下钻线索 findings；大上下文时在本 Skill 内启用 sub agent/agent team。
version: 1.6.0
---

# AI小万经营分析 v1.6

## 职责

本 Skill 只负责 `analyze` 阶段：

```text
读取 process 结果
读取近 10 周历史
读取异动规则
生成 findings
必要时启用 sub agent / agent team
写 analyze 阶段结果
```

输出是“下钻线索”，不是强业务结论；建议只给下一步看哪里，不直接给调价、补贴、策略动作。

## sub agent 触发条件

满足任一条件时启用 sub agent/agent team：

```text
候选异常品类 > 20
候选异常机型 > 100
单品类上下文过大
需要按品类簇并行分析
```

拆分顺序：`品类簇 → 品类 → 异常机型 → 属性/成色/履约方式`。

## findings 输出要求

每条 finding 必须包含：

```json
{
  "level": "category",
  "entity_type": "category",
  "entity_name": "内存条",
  "metric": "gmv",
  "direction": "down",
  "severity": "high",
  "confidence": "medium",
  "drilldown_path": [],
  "evidence": [],
  "recommended_drilldowns": [],
  "data_warnings": []
}
```

## 执行步骤

1. 调用 `/api/aiwan/read`，`stage=analyze`。
2. include 必须包含：`history_10w`、`rules`、`previous_stage_outputs`。
3. 如果缺少 process 输出，写 failed checkpoint。
4. 生成 findings 后写回 `/api/aiwan/write`：
   - `stage=analyze`
   - `output_type=analysis_result`
   - `payload.summary`
   - `payload.findings`
   - `payload.warnings`


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


