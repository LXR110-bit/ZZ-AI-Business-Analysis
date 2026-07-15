# AI 小万 Analyze Loop

## 绑定 Skill

```text
小万经营分析
```

## 调度建议

```text
每天 07:25 Asia/Shanghai
```

时间只是兜底；真正依赖必须通过 active_process_manifest 检查。

## 目标

消费数据处理阶段的 analysis_history，生成 evidence_pack、insights、summary、review_notes、analysis_trace、active_analysis_manifest。

## 前置检查

```json
{
  "required_upstream_manifest": "active_process_manifest.json",
  "required_stage": "process",
  "allowed_status": ["success", "warn"],
  "required_run_dt": "${run_dt}",
  "verify_sha256": true,
  "effective_history_weeks_source": "history_weeks_available_first",
  "if_effective_history_weeks_less_than_8": "downgrade_to_wow_only"
}
```

## 固定输入

```json
{
  "task": "AI 小万经营洞察分析",
  "mode": "scheduled_loop",
  "analysis_mode": "daily",
  "evidence_policy": {
    "generate_evidence_pack_first": true,
    "do_not_send_full_excel_to_llm": true,
    "require_evidence_id": true
  },
  "llm_policy": {
    "allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"],
    "fallback_to_other_llm": false,
    "daily": {
      "primary_writer": "GLM-5.2",
      "reviewer": "DeepSeek V4 Pro"
    },
    "deep_dive": {
      "primary_analyst": "DeepSeek V4 Pro",
      "formatter": "GLM-5.2"
    }
  },
  "outputs": {
    "evidence_pack": true,
    "insights": true,
    "summary": true,
    "review_notes": true,
    "analysis_trace": true,
    "active_analysis_manifest": true
  }
}
```

## 成功判定

- evidence_pack 生成；
- insights.json 与 summary.md 生成；
- review_notes.md 生成；
- active_analysis_manifest.status=success 或 warn；
- 不输出最终 pass，最终裁决交给 Validate Loop。
