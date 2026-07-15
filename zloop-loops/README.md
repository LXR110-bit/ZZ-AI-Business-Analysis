# AI 小万 zloop 4 Skill + 4 Loop

当前按用户确认，AI 小万迁移采用 4 个流程、4 个 Skill、4 个 Loop。每个 Loop 只绑定一个 Skill。

| 顺序 | Loop | Skill | 主要职责 | LLM |
| ---: | --- | --- | --- | --- |
| 1 | `ai-wan-fetch-loop.md` | 小万经营取数 | 跑 6 个 SQL，输出 raw_cache/sql_status | 不调用 |
| 2 | `ai-wan-process-loop.md` | 小万数据处理 | 周日均、rolling、10周历史、server_cache_bundle | 不调用 |
| 3 | `ai-wan-analyze-loop.md` | 小万经营分析 | evidence_pack、GLM/DeepSeek 分析 | GLM-5.2 + DeepSeek V4 Pro |
| 4 | `ai-wan-validate-loop.md` | 小万经营校验 | 数据/洞察/schema/模型白名单校验 | 规则为主，DeepSeek 可语义复核 |

## 推荐调度

```text
06:30 Fetch Loop
06:55 Process Loop
07:25 Analyze Loop
07:45 Validate Loop
```

时间只是兜底，真正依赖必须靠 active manifest：

```text
active_fetch_manifest.json
active_process_manifest.json
active_analysis_manifest.json
active_validation_manifest.json
```

下游 Loop 必须检查 upstream run_dt / run_id / status / sha256，不允许读旧数据继续。

## 服务器展示

zloop 负责生成 `server_cache_bundle_<run_dt>.zip`，服务器负责展示和访问控制。后续可由服务器拉取或人工同步该 bundle 到 dashboard 数据目录。当前 Validate Loop 不自动发布服务器、不自动推飞书。
