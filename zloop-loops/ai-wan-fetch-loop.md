# AI 小万 Fetch Loop

## 绑定 Skill

```text
小万经营取数
```

## 调度建议

```text
每天 06:30 Asia/Shanghai
```

## 目标

执行 6 个 Hive SQL，生成 raw_cache / sql_status / raw_manifest / active_fetch_manifest。此 Loop 不做数据处理、不调用 LLM。

## 固定输入

```json
{
  "task": "AI 小万聚合回收取数",
  "mode": "scheduled_loop",
  "run_dt_policy": "T-1",
  "sql_scope": "all",
  "output_raw_results": true,
  "upload_to_cloud": true,
  "active_manifest": "active_fetch_manifest.json",
  "stop_on_sql_error": true
}
```

## 成功判定

- 6 SQL SUCCESS；
- raw_cache、sql_status、raw_manifest、active_fetch_manifest 均生成；
- active_fetch_manifest.status=success。
