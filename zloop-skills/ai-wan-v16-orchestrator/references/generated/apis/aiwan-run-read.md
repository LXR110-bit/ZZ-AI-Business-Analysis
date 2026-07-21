# AI小万-读取运行阶段上下文

## API 标识

- public_id: `f3f2a89f-3c54-4f3d-92a0-04d2a25a6b8d`
- name: `aiwan:run:read`
- method/path: `POST /api/aiwan/read`
- auth_mode: `none`
- risk_level: `low`
- is_mutation: `false`

## 用途说明

读取 AI小万指定运行和阶段所需的分析上下文、规则及前序阶段输出

当 AI小万多阶段经营分析 Skill 需要开始 read、process、analyze 或 validate 阶段时调用。请求体提供 run_id、stage、week，可选 include 与 history_weeks；返回运行元信息、10周历史、指标快照、候选异动、规则以及已完成的前序阶段输出。若必需前序阶段缺失，返回 ok=false 和 missing_previous_stages，调用方应停止后续阶段并补齐输入。 当前接口不需要额外上游凭证 header；调用方只提交 JSON body。

## Request Schema

```json
{
  "properties": {
    "body": {
      "properties": {
        "history_weeks": {
          "default": 10,
          "maximum": 52,
          "minimum": 1,
          "type": "integer"
        },
        "include": {
          "items": {
            "enum": [
              "run_meta",
              "history_10w",
              "metric_snapshot",
              "candidate_anomalies",
              "rules",
              "previous_stage_outputs"
            ],
            "type": "string"
          },
          "type": "array"
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
        "week": {
          "description": "ISO 周，如 2026-W29",
          "type": "string"
        }
      },
      "required": [
        "run_id",
        "stage"
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
    "context": {
      "description": "按 include 返回运行元信息、历史、指标快照、候选异动和规则",
      "type": "object"
    },
    "missing_previous_stages": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "ok": {
      "type": "boolean"
    },
    "previous_outputs": {
      "description": "当前阶段之前已完成阶段的输出",
      "type": "object"
    },
    "run_id": {
      "type": "string"
    },
    "stage": {
      "type": "string"
    },
    "warnings": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "week": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "ok",
    "run_id",
    "stage",
    "context",
    "previous_outputs",
    "warnings"
  ],
  "type": "object"
}
```

## Examples

```json
{
  "request": {
    "body": {
      "history_weeks": 10,
      "include": [
        "run_meta",
        "history_10w",
        "metric_snapshot",
        "candidate_anomalies",
        "rules",
        "previous_stage_outputs"
      ],
      "run_id": "apihub-read-2026-W29",
      "stage": "read",
      "week": "2026-W29"
    }
  },
  "response": {
    "context": {
      "candidate_anomalies": [],
      "history_10w": {
        "weeks": [
          "2026-W20",
          "2026-W29"
        ]
      },
      "metric_snapshot": {
        "week": "2026-W29"
      },
      "rules": {},
      "run_meta": {
        "status": "running"
      }
    },
    "ok": true,
    "previous_outputs": {},
    "run_id": "apihub-read-2026-W29",
    "stage": "read",
    "warnings": [],
    "week": "2026-W29"
  }
}
```
