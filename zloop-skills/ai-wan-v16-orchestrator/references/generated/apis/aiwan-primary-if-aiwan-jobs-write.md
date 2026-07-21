# aiwan-AI小万-任务控制面-创建领取与状态更新

## API 标识

- public_id: `d2d9e941-7662-4361-9ad8-f73d38cbd92b`
- name: `aiwan:primary:if_aiwan_jobs_write`
- method/path: `POST /api/aiwan/jobs/write`
- auth_mode: `none`
- risk_level: `medium`
- is_mutation: `true`

## 用途说明

通过 action=create|claim|state 在一个固定入口完成 job 幂等创建、CAS 租约领取或续租、状态推进与 SQL checkpoint 持久化。

调用时机: Loop1 创建任务时用 create，执行 SQL 或处理前用 claim，保存 execute_id、轮询状态、产物或发布状态时用 state；每次成功后调用 jobs/read 复读。
业务用途: 通过 action=create|claim|state 在一个固定入口完成 job 幂等创建、CAS 租约领取或续租、状态推进与 SQL checkpoint 持久化。
请求参数: JSON body 必须包含 action。create 还需 kind、analysis_key、week、data_end_date、loop1_run_id 与 revision；claim 需 analysis_key、revision、expected_state_revision、worker_id；state 需同一 job 标识、expected_state_revision、worker_id、status，可合并 sql_checkpoints。
响应消费: 业务成功以 ok=true 为准。create 消费 created/job，claim 消费 claimed/renewed 与新 revision，state 消费递增后的 revision 和 checkpoint；任一 4xx error.code 都阻断当前写链路并转 jobs/read 复读。
副作用: 调用前确认 action、analysis_key、kind、revision、expected_state_revision 和 worker_id 属于本次 Loop；CAS/租约冲突、非法状态迁移和未知 action 均不得继续写。
认证和运行态: 不依赖 dashboard 页面 cookie；API Hub runtime 负责授权，worker_id 仅是业务租约 owner，不是认证凭据。

## Request Schema

```json
{
  "content_type": "",
  "params": [],
  "summary": "JSON body 必须包含 action。create 还需 kind、analysis_key、week、data_end_date、loop1_run_id 与 revision；claim 需 analysis_key、revision、expected_state_revision、worker_id；state 需同一 job 标识、expected_state_revision、worker_id、status，可合并 sql_checkpoints。"
}
```

## Response Schema

```json
{
  "consumed_fields": [
    "ok",
    "created",
    "claimed",
    "renewed",
    "job.status",
    "job.state_revision",
    "job.lease_owner",
    "job.lease_expires_at",
    "job.sql_checkpoints",
    "error.code",
    "error.details"
  ],
  "summary": "业务成功以 ok=true 为准。create 消费 created/job，claim 消费 claimed/renewed 与新 revision，state 消费递增后的 revision 和 checkpoint；任一 4xx error.code 都阻断当前写链路并转 jobs/read 复读。"
}
```

## Examples

```json
{
  "request": {
    "content_type": "",
    "params": [],
    "summary": "JSON body 必须包含 action。create 还需 kind、analysis_key、week、data_end_date、loop1_run_id 与 revision；claim 需 analysis_key、revision、expected_state_revision、worker_id；state 需同一 job 标识、expected_state_revision、worker_id、status，可合并 sql_checkpoints。"
  },
  "response": {
    "consumed_fields": [
      "ok",
      "created",
      "claimed",
      "renewed",
      "job.status",
      "job.state_revision",
      "job.lease_owner",
      "job.lease_expires_at",
      "job.sql_checkpoints",
      "error.code",
      "error.details"
    ],
    "summary": "业务成功以 ok=true 为准。create 消费 created/job，claim 消费 claimed/renewed 与新 revision，state 消费递增后的 revision 和 checkpoint；任一 4xx error.code 都阻断当前写链路并转 jobs/read 复读。"
  },
  "scenarios": [
    {
      "presetParams": [
        {
          "name": "action",
          "value": "create"
        }
      ],
      "title": "创建或幂等复用 job"
    },
    {
      "presetParams": [
        {
          "name": "action",
          "value": "claim"
        }
      ],
      "title": "CAS 领取或续租"
    },
    {
      "presetParams": [
        {
          "name": "action",
          "value": "state"
        }
      ],
      "title": "推进状态并保存 SQL checkpoint"
    }
  ]
}
```
