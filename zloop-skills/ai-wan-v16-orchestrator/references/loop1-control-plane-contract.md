# Loop1 跨 tick 控制面契约

## 注册状态

阶段 A Loop1 使用 **两个已发布 API Hub capability**，不再依赖四个 REST 子路径分别注册。远程 Runtime 只通过 `zloop_runtime.hub` 调用 canonical v2 path，不拼网关 URL、认证头或旧 `/api/aiwan/read|write` 控制面。

| 作用 | 注册接口 | Public ID | Runtime path |
|---|---|---|---|
| 读取任务与检查点 | `POST /api/aiwan/jobs/read` | `2a56c817-134d-409a-b457-9ecf859217eb` | `POST /v2/aiwan/api/aiwan/jobs/read` |
| 创建、领取和状态更新 | `POST /api/aiwan/jobs/write` | `d2d9e941-7662-4361-9ad8-f73d38cbd92b` | `POST /v2/aiwan/api/aiwan/jobs/write` |

`jobs/read` 是只读恢复与写后复读入口；`jobs/write` 通过 `action=create|claim|state` 承载幂等创建、CAS 领取/续租、状态推进和 SQL checkpoint 持久化。`PATCH .../state`、`GET .../{analysis_key}`、`POST .../{analysis_key}/claim` 等仅是本地服务兼容形态，不作为 Skill/API Hub 绑定依据。

## 唯一标识与 CAS

```text
analysis_key = week + ":" + data_end_date
job_id = kind + analysis_key + base_revision + handoff_revision
```

每次 `action=claim|state` 必须带 `expected_state_revision`。领取后必须带稳定 `worker_id`；同 owner 每 tick 续租，过期后其他 worker 可接管，但不能清空已保存的 SQL 进度。

## jobs/read 请求

```json
{
  "kind": "base",
  "analysis_key": "YYYY-Www:YYYY-MM-DD",
  "base_revision": 1,
  "handoff_revision": 0
}
```

消费 `job.status`、`job.state_revision`、`job.lease_owner`、`job.lease_expires_at`、`job.sql_checkpoints`。读取失败或 404 `JOB_NOT_FOUND` 时，当前 tick 不得伪造成业务成功。

## jobs/write action

- `action=create`：创建或幂等复用 base job；重复 revision 的完整 payload 必须一致，否则按业务冲突失败。drilldown handoff 仅为预留能力，不纳入当前 Loop1 上线闭环。
- `action=claim`：按 `expected_state_revision` 领取或续租；CAS/租约冲突时停止当前写链路并转 `jobs/read` 复读。
- `action=state`：推进状态并合并 SQL checkpoint；成功后必须调用 `jobs/read` 复读权威状态。

## 状态机

```text
ready → claimed → sql_submitted → sql_running → materializing
      → processing → analyzing → validating → published

非终态 → retryable_failed → claimed
非终态 → failed
旧日期/旧版本 → superseded
```

- SQL 平台终态失败最多重提 2 次，`retry_count` 与新 `execute_id` 每次都立即 CAS。
- 排队/运行中只 poll 原 `execute_id`，禁止重提。
- base job 首次创建时未给 deadline，服务器默认 `created_at + 60m`；正式 Prompt 优先传计划启动时间 + 60m。
- deadline 过期只写 `base_delayed`/`BASE_SLA_DEADLINE_EXCEEDED` 告警，不参与 claim/state 写入门禁；原 revision 可继续恢复。
- deadline 后发布仍保持兼容状态 `status=published`，并额外记录 `publication_status=late_published`、`delivery_state=late_published`。
- 新 base revision 或同周更新数据日到达时，旧活跃 base 立即 `superseded`。drilldown handoff 若存在，仅按预留能力排查，不作为当前发布状态来源。

## SQL checkpoint

每个脚本名下持久化：

```json
{
  "execute_id": "...",
  "sql_hash": "...",
  "status": "SUBMITTED|RUNNING|SUCCESS|FAILED",
  "retry_count": 0,
  "artifact_uri": "...",
  "artifact_hash": "...",
  "materialized_at": "ISO-8601"
}
```

Loop1 只允许：`category_daily_avg`、`category_summary`、`category_fulfill_daily_avg`、`category_fulfill_summary`、`sqldau`。其中 `sqldau` 是 APP DAU/回收入口 UV 的正式生产来源，必须与其他 SQL 一样保存 execute_id、SQL hash、CSV hash 和 materialized checkpoint。

升 revision 复用 checkpoint 时必须同时满足：同一 `analysis_key/week/data_end_date`、当前渲染 SQL hash 等于旧 checkpoint `sql_hash`、旧 `artifact_uri` 文件存在、文件 SHA256 等于 `artifact_hash`。逐 checkpoint 判断；未命中项正常提交 SQL。

## 发布与交接

1. validate 携带 `publication_bundle`（category cache/taxonomy/board metrics）和分析结果；服务端全部校验后先落基础缓存，最后原子替换 `dashboard.json`。
2. 复读 stage revision 及 dashboard `analysisStatus.analysis_key/data_end_date/base_revision`。
3. 当前上线闭环固定 `model_enrichment_mode=disabled`，dashboard 必须为 `base_published`，不设 `model_sla_deadline`。
4. base job 通过 `jobs/write action=state` 标记 `published`，再用 `jobs/read` 复读。
5. 不要求创建 `kind=drilldown` handoff；若历史逻辑或预留能力生成 handoff，它不得影响 base 发布成功判定。

交接创建失败不撤回已发布基础结果；后续 tick 必须继续幂等补建。

## Dashboard 投影

- 活跃 base job → `base_running`
- 超过 base deadline 或 `retryable_failed` → `base_delayed`
- `failed` → `base_failed`
- validate 发布且 mode=disabled → `base_published`
- 超时后成功发布 → `late_published`（同时保留控制面 `status=published` 兼容性）

所有值只写 `analysisStatus.deliveryState`，不得覆盖 `analysisStatus.state=rolling|final`。
