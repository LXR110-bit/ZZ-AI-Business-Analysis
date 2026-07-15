# AI 小万 Validate Loop

## 绑定 Skill

```text
小万经营校验
```

## 调度建议

```text
每天 07:45 Asia/Shanghai
```

时间只是兜底；真正依赖必须通过 active_analysis_manifest / active_process_manifest 检查。

## 目标

消费 process 与 analysis 两阶段产物，执行最终数据质量、evidence、schema、LLM 白名单、known_gap、过度归因、核心机型遗漏和高严重度异常遗漏校验，输出 validation_report、final_status、active_validation_manifest。

## 前置检查

```json
{
  "required_process_manifest": "active_process_manifest.json",
  "required_analysis_manifest": "active_analysis_manifest.json",
  "required_run_dt": "${run_dt}",
  "verify_sha256": true,
  "on_mismatch": "failed_do_not_publish"
}
```

## 固定输入

```json
{
  "task": "AI 小万经营分析最终校验",
  "mode": "scheduled_loop",
  "validation_scope": [
    "data_quality",
    "history_window",
    "evidence_id",
    "insights_schema",
    "model_tag_knowledge",
    "known_gap",
    "llm_policy",
    "over_attribution",
    "output_safety",
    "card_payload_readiness",
    "core_model_omission",
    "high_severity_anomaly_omission"
  ],
  "llm_policy": {
    "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"],
    "semantic_review_model": "DeepSeek V4 Pro",
    "fallback_to_other_llm": false
  },
  "publish_policy": {
    "server_publish": false,
    "feishu_push": false,
    "reason": "当前阶段只校验，不自动发布或推送"
  },
  "outputs": {
    "validation_report": true,
    "final_status": true,
    "active_validation_manifest": true
  }
}
```

## 成功判定

- validation_report 生成；
- final_status 生成；
- active_validation_manifest 生成；
- final_status 明确 pass / warn / failed；
- 默认不自动发布服务器、不自动推飞书。
