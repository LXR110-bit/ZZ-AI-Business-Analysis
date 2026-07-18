# AI小万 APIHub Call Playbook

## Binding status

- `api_binding_status`: `bound`
- `runtime_client`: `hub`
- `call_sequence_status`: `pending_trial`
- 验证依据：APIHub discovery 的已发布接口 description、用户提供的真实 Loop 失败证据、真实 AI 应用 read/write/reread 验收，以及本次沙箱 HELPERS.md/help() 签名核验。

## API bindings

### 阶段 A Loop1 控制面（当前 Skill 绑定）

1. `aiwan:primary:if_aiwan_jobs_read` — `2a56c817-134d-409a-b457-9ecf859217eb` — `POST /api/aiwan/jobs/read` → `/v2/aiwan/api/aiwan/jobs/read`
2. `aiwan:primary:if_aiwan_jobs_write` — `d2d9e941-7662-4361-9ad8-f73d38cbd92b` — `POST /api/aiwan/jobs/write` → `/v2/aiwan/api/aiwan/jobs/write`

调用详情见 `references/loop1-control-plane-contract.md`。Loop1 只通过这两个 capability 做跨 tick 恢复、CAS 租约、SQL checkpoint、发布复读和 handoff。

### full6 兼容入口

`aiwan_inline_state_machine.py` 仍保留旧 full6 read/write 代码路径用于兼容回归，但它不是阶段 A Loop1 控制面，也不作为本 v31 候选包的主调度路径。正式阶段 A 调度不得从旧 `/api/aiwan/read|write` 推断 checkpoint 状态。

## 固定调用顺序（v1.6.5）

APIHub 不再是每阶段 checkpoint 中心。四阶段职责必须严格区分：

```text
read 阶段：禁止 AIWAN read/write；委托 xinghe-data-explore 执行 SQL，生成 raw_cache/read_result。
process 阶段：禁止 AIWAN read/write；消费 raw_cache，读取飞书品类映射或快照，生成 processed_data/category_mapping_manifest。
analyze 阶段：只允许 AIWAN read；读取 server_context，生成 findings/display_insights；禁止 write。
validate 阶段：执行校验后 AIWAN write；写后 reread 确认 revision/output_type。
```

完整运行：

```text
read(xinghe + raw_cache)
→ process(processed_data + category_mapping_manifest)
→ analyze(APIHub read + display_insights)
→ validate(APIHub write + reread)
```

## known_gaps

- APIHub discovery detail 当前没有返回独立 `cliInvocation` 字段；transport 根据已发布 POST request Schema 确认为 JSON body，并通过 `zloop_runtime.hub.post` 执行。
- 不存在 Skill 自行读取自定义上游 token 环境变量的设计；不得在 Skill 中发明环境变量、手工凭证头、回退裸 URL、`zloop api` 或本地 checkpoint。若 APIHub 注册仍要求额外上游凭证，应修正 APIHub/上游鉴权契约。

## Trial-run 验收

试跑必须使用唯一 run_id，并记录：

- analyze read、validate write/reread 是否均 `ok=true`；
- 四阶段 status/revision/output_type；
- analysis_result.display_contract/display_insights 是否满足服务器 bridge 契约；
- validate 的 `overall_status`、`checks`、`warnings`、`publish_allowed`；
- APIHub trace/audit 标识（若响应头返回）；
- 验证 runtime 未手工构造任何凭证头；鉴权由 APIHub registration 完成。
