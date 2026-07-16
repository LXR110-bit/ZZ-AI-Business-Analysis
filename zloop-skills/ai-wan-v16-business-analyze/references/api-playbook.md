# AI小万 v1.6 Analyze APIHub Call Playbook

## Binding status

- `api_binding_status`: `bound`
- `runtime_client`: `hub`
- `call_sequence_status`: `pending_trial`
- route decision: `update-owned`
- 本阶段只读：`aiwan:run:write` 属于 validate 阶段，不属于 analyze 阶段。

## API binding

1. `aiwan:run:read` — `f3f2a89f-3c54-4f3d-92a0-04d2a25a6b8d`

调用详情见 `references/apihub-read-write-contract.md`；v2 透明反向代理规则由 `zloop_runtime.hub` 封装，Skill 只传相对 path `/v2/aiwan/api/aiwan/read`。

## Analyze 固定调用顺序

```text
validate processed_data
→ read(stage=analyze)
→ build evidence_pack
→ GLM-5.2 primary generation
→ DeepSeek V4 Pro review
→ deterministic merge
→ return analysis_result to orchestrator
```

本阶段不执行：

```text
write(stage=analyze)
reread(stage=analyze)
```

最终写服务器由 `AI小万结果校验 v1.6` 在 validate 阶段完成。

## known_gaps

- APIHub discovery detail 当前没有返回独立 `cliInvocation` 字段；transport 根据已发布 POST request Schema 确认为 JSON body，并通过 `zloop_runtime.hub.post` 执行。
- call sequence 仍需最新待验证技能包试跑后才能标记 `verified`。
- 不存在 Skill 自行读取自定义上游 token 环境变量的设计；不得在 Skill 中发明环境变量、手工凭证头、回退裸 URL、`zloop api` 或本地 checkpoint。

## Trial-run 验收

试跑必须使用唯一 run_id，并记录：

- APIHub read 是否 `ok=true`；
- 返回上下文是否只用于生成 evidence_pack；
- `analysis_result.output_type == analysis_result`；
- `analysis_result.evidence_pack.evidence_index` 是否覆盖全部 finding 的 `evidence_ids`；
- 未执行 write/reread；
- runtime 未手工构造任何凭证头，鉴权由 APIHub registration 完成。
