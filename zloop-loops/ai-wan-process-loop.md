# AI 小万 Process Loop

## 绑定 Skill

```text
小万数据处理
```

## 调度建议

```text
每天 06:55 Asia/Shanghai
```

时间只是兜底；真正依赖必须通过 active_fetch_manifest 检查。

## 目标

消费 Fetch Loop 的 raw_cache，复制旧服务器数据处理流程，生成 imports、Excel、manifest、processed_cache、server_cache_bundle、analysis_history、data_quality_report、model_tag_snapshot、model_tag_knowledge、model_tag_sync_manifest、active_process_manifest。

## 前置检查

```json
{
  "required_upstream_manifest": "active_fetch_manifest.json",
  "required_stage": "fetch",
  "required_status": "success",
  "required_run_dt": "${run_dt}",
  "verify_sha256": true,
  "on_missing_or_failed": "stop_do_not_use_old_data"
}
```

## 固定输入

```json
{
  "task": "AI 小万数据处理与历史缓存",
  "mode": "scheduled_loop",
  "run_dt_policy": "T-1",
  "history_weeks": 10,
  "dashboard_window_weeks": 2,
  "cache_policy": {
    "enabled": true,
    "rolling_week_overwrite": true,
    "final_week_freeze": true,
    "persist_cache_to_cloud": true
  },
  "outputs": {
    "imports_zip": true,
    "excel": true,
    "manifest": true,
    "processed_cache": true,
    "server_cache_bundle": true,
    "analysis_history": true,
    "data_quality_report": true,
    "model_tag_snapshot": true,
    "model_tag_knowledge": true,
    "model_tag_feishu_summary": true,
    "model_tag_sync_manifest": true,
    "active_process_manifest": true
  },
  "server_display": {
    "enabled": true,
    "bundle_name": "server_cache_bundle_${run_dt}.zip",
    "server_publish": "out_of_scope_manual_or_downstream"
  }
}
```

## 成功判定

- 上游 fetch manifest 校验通过；
- 6 imports CSV、Excel、manifest 生成；
- processed_cache 和 server_cache_bundle 生成；
- analysis_history 生成；
- data_quality_report 生成；
- model_tag_snapshot / model_tag_knowledge / model_tag_sync_manifest 生成；标签源缺失或飞书未配置时标 warn，不阻塞数据包；
- active_process_manifest.status=success 或 warn。
