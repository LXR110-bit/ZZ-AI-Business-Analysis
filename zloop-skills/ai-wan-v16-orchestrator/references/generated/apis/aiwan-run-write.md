# AI小万-写入运行阶段结果

## API 标识

- public_id: `c7af7d71-d114-44f4-87ac-8d225ad0b6c4`
- name: `aiwan:run:write`
- method/path: `POST /api/aiwan/write`
- auth_mode: `none`
- risk_level: `medium`
- is_mutation: `true`

## 用途说明

写入 AI小万指定运行阶段的结果并更新运行状态、阶段 revision 与落盘记录

当 AI小万的 read、process、analyze 或 validate 阶段已完成并需要持久化结果时调用。请求体必须包含 run_id、stage、status 和 payload，可补充 week、output_type、artifacts、warnings、started_at、finished_at、rerun 与 rerun_reason。接口会按 run_id/stage 写入 JSON，重复写同阶段时 revision 自动递增并标记 overwritten_previous_revision，同时聚合更新 run 状态。调用前必须确认 run_id、stage 与 payload 属于本次运行，避免覆盖错误阶段。 当前接口不需要额外上游凭证 header；调用方只提交 JSON body。

## Request Schema

```json
{
  "properties": {
    "body": {
      "properties": {
        "artifacts": {
          "items": {
            "type": "object"
          },
          "type": "array"
        },
        "finished_at": {
          "format": "date-time",
          "type": [
            "string",
            "null"
          ]
        },
        "output_type": {
          "type": "string"
        },
        "payload": {
          "type": "object"
        },
        "rerun": {
          "default": false,
          "type": "boolean"
        },
        "rerun_reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "run_id": {
          "description": "本次多阶段运行唯一标识",
          "type": "string"
        },
        "stage": {
          "enum": [
            "read",
            "process",
            "analyze",
            "validate"
          ],
          "type": "string"
        },
        "started_at": {
          "format": "date-time",
          "type": [
            "string",
            "null"
          ]
        },
        "status": {
          "enum": [
            "pending",
            "running",
            "success",
            "warn",
            "failed",
            "skipped"
          ],
          "type": "string"
        },
        "warnings": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "week": {
          "description": "ISO 周，如 2026-W29",
          "type": "string"
        }
      },
      "required": [
        "run_id",
        "stage",
        "status",
        "payload"
      ],
      "type": "object"
    }
  },
  "required": [
    "body"
  ],
  "type": "object"
}
```

## Response Schema

```json
{
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "output": {
      "properties": {
        "artifacts": {
          "type": "array"
        },
        "output_type": {
          "type": "string"
        },
        "overwritten_previous_revision": {
          "type": "boolean"
        },
        "payload": {
          "type": "object"
        },
        "revision": {
          "type": "integer"
        },
        "run_id": {
          "type": "string"
        },
        "stage": {
          "type": "string"
        },
        "status": {
          "type": "string"
        },
        "warnings": {
          "type": "array"
        },
        "week": {
          "type": [
            "string",
            "null"
          ]
        },
        "written_at": {
          "type": "string"
        }
      },
      "type": "object"
    },
    "revision": {
      "type": "integer"
    },
    "run": {
      "description": "聚合后的运行状态及各阶段摘要",
      "type": "object"
    },
    "run_id": {
      "type": "string"
    },
    "stage": {
      "type": "string"
    },
    "status": {
      "type": "string"
    }
  },
  "required": [
    "ok",
    "run_id",
    "stage",
    "status",
    "revision",
    "run",
    "output"
  ],
  "type": "object"
}
```

## Examples

```json
{
  "request": {
    "body": {
      "artifacts": [],
      "output_type": "read_result",
      "payload": {
        "records": 1,
        "source": "apihub-smoke-test"
      },
      "rerun": false,
      "run_id": "apihub-write-2026-W29",
      "stage": "read",
      "status": "success",
      "warnings": [],
      "week": "2026-W29"
    }
  },
  "response": {
    "ok": true,
    "output": {
      "artifacts": [],
      "output_type": "read_result",
      "overwritten_previous_revision": false,
      "payload": {
        "records": 1,
        "source": "apihub-smoke-test"
      },
      "revision": 1,
      "run_id": "apihub-write-2026-W29",
      "stage": "read",
      "status": "success",
      "warnings": [],
      "week": "2026-W29",
      "written_at": "2026-07-16T00:00:00.000Z"
    },
    "revision": 1,
    "run": {
      "current_stage": "read",
      "run_id": "apihub-write-2026-W29",
      "stages": {
        "read": {
          "revision": 1,
          "status": "success"
        }
      },
      "status": "running",
      "week": "2026-W29"
    },
    "run_id": "apihub-write-2026-W29",
    "stage": "read",
    "status": "success"
  }
}
```
