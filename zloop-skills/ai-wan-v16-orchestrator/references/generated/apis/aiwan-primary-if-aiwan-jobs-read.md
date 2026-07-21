# aiwan-AI小万-任务控制面-读取任务与检查点

## API 标识

- public_id: `2a56c817-134d-409a-b457-9ecf859217eb`
- name: `aiwan:primary:if_aiwan_jobs_read`
- method/path: `POST /api/aiwan/jobs/read`
- auth_mode: `none`
- risk_level: `low`
- is_mutation: `true`

## 用途说明

按 analysis_key 和 revision 读取持久化 job、租约、状态及 SQL checkpoint，作为跨 tick 恢复和所有写操作后的权威核验源。

调用时机: 每个 Loop1 tick 恢复任务时、jobs/write 成功后复读时，以及判断任务是否 published、failed 或 superseded 时调用。
业务用途: 按 analysis_key 和 revision 读取持久化 job、租约、状态及 SQL checkpoint，作为跨 tick 恢复和所有写操作后的权威核验源。
请求参数: JSON body 的 analysis_key 来自 Loop1 稳定参数或 create 返回；kind、base_revision、handoff_revision 用于精确选择 base 或 drilldown job。read 不需要 action 字段。
响应消费: 业务成功以 ok=true 且 job 非空为准；消费 job.status、state_revision、lease、sql_checkpoints。404 JOB_NOT_FOUND 表示当前没有可恢复任务。
副作用: 这是只读 POST，不修改 job；调用前仍需确认 analysis_key、kind 与 revision 指向本次 Loop，避免把其他任务的 checkpoint 当成当前状态。
认证和运行态: 不依赖 dashboard 页面 cookie；只通过已授权 zloop_runtime.hub/API Hub runtime 调用。

## Request Schema

```json
{
  "content_type": "",
  "params": [],
  "summary": "JSON body 的 analysis_key 来自 Loop1 稳定参数或 create 返回；kind、base_revision、handoff_revision 用于精确选择 base 或 drilldown job。read 不需要 action 字段。"
}
```

## Response Schema

```json
{
  "consumed_fields": [
    "ok",
    "job.status",
    "job.state_revision",
    "job.lease_owner",
    "job.lease_expires_at",
    "job.sql_checkpoints",
    "error.code"
  ],
  "summary": "业务成功以 ok=true 且 job 非空为准；消费 job.status、state_revision、lease、sql_checkpoints。404 JOB_NOT_FOUND 表示当前没有可恢复任务。"
}
```

## Examples

```json
{
  "request": {
    "content_type": "",
    "params": [],
    "summary": "JSON body 的 analysis_key 来自 Loop1 稳定参数或 create 返回；kind、base_revision、handoff_revision 用于精确选择 base 或 drilldown job。read 不需要 action 字段。"
  },
  "response": {
    "consumed_fields": [
      "ok",
      "job.status",
      "job.state_revision",
      "job.lease_owner",
      "job.lease_expires_at",
      "job.sql_checkpoints",
      "error.code"
    ],
    "summary": "业务成功以 ok=true 且 job 非空为准；消费 job.status、state_revision、lease、sql_checkpoints。404 JOB_NOT_FOUND 表示当前没有可恢复任务。"
  },
  "scenarios": [
    {
      "presetParams": [
        {
          "name": "kind",
          "value": "base"
        }
      ],
      "title": "跨 tick 恢复 base job"
    },
    {
      "presetParams": [
        {
          "name": "kind",
          "value": "drilldown"
        }
      ],
      "title": "读取 drilldown handoff"
    }
  ]
}
```
