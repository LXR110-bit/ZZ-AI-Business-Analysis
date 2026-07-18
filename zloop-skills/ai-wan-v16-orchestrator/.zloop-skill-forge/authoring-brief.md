# Authoring Brief — ai-wan-v16-orchestrator

- source_type: from-existing-skill
- mode: update
- route_decision: update-owned/bound
- route_evidence: 本轮是对用户自有 AI 小万主编排的 update，阶段 A Loop1 控制面已收敛为 jobs/read + jobs/write 两个已发布 capability；本地包需要绑定这两个 public id 后进入 package-check 与远程 disabled trial-run。
- route_next_action: 已通过管理详情和网关 smoke 确认 jobs/read + jobs/write；将两个 public id 写入 api_dependencies 后，以 v30 为 baseline 跑 package-check/trial-run，trial-run 业务成功前不 apply/启用正式 Loop；2026-07-18 disabled trial-run 已跑到 validate，但被 dashboard analysisStatus 复读不匹配阻断。
- target_skill_public_id: b28e30d2-b8c6-456f-888d-57c48785286f
- base_skill_version_id: 27a72c0111044617975bcc17dff17d2b
- stage: orchestrator
- api_chain_status: present
- runtime_clients: [hub, xinghe]
- api_binding_status: bound_two_endpoint_jobs
- call_sequence_status: blocked_validate_reread_mismatch_after_disabled_trial
- api_resolutions:
  - name: aiwan:primary:if_aiwan_jobs_read
    original_path: POST /api/aiwan/jobs/read
    public_id: 2a56c817-134d-409a-b457-9ecf859217eb
    method: POST
    registered_path: /api/aiwan/jobs/read
    domain: aiwan
    legacy_path_enabled: false
    runtime_path: /v2/aiwan/api/aiwan/jobs/read
    resolution: hub
    status: published
    permission_status: granted
    resolved_at: 2026-07-18T01:00:00+08:00
    evidence: 管理详情确认 auth_mode=none、base_url=http://10.47.193.16、legacy=false、status=published；网关 read smoke 返回上游 404 业务缺失而非路由/鉴权失败。
  - name: aiwan:primary:if_aiwan_jobs_write
    original_path: POST /api/aiwan/jobs/write
    public_id: d2d9e941-7662-4361-9ad8-f73d38cbd92b
    method: POST
    registered_path: /api/aiwan/jobs/write
    domain: aiwan
    legacy_path_enabled: false
    runtime_path: /v2/aiwan/api/aiwan/jobs/write
    resolution: hub
    status: published
    permission_status: granted
    resolved_at: 2026-07-18T01:00:00+08:00
    evidence: 管理详情确认 auth_mode=none、base_url=http://10.47.193.16、legacy=false、status=published；此前网关 create→claim→state→read 已验证到 revision 3。
- removed_unresolved_calls:
  - GET /workbench/api/v1/artifact-files/{id}/{filename}
  - GET /workbench/api/v1/artifact-files/{id}
  - reason: Hub discovery 无精确匹配；已删除动态 Hub fallback，SQL 全量结果仅通过 xinghe.materialize_result_file 的 output_path、平台签名 HTTPS URL、本地文件或嵌入内容落盘。
- permission_gaps: []
- known_gaps:
  - 现有 Loop job 98cd6ff0-007a-4796-b0fc-1addf37f1add 仍 disabled，Prompt 仍是硬编码日期的 full6。
  - zloop Loop 单 job 当前为 daily 06:10；需要设计 10 分钟 tick 触发方式才能满足 60 分钟 SLA。
  - 2026-07-18 disabled trial-run 已验证 jobs/read/write、4 SQL checkpoint、materialize/process/analyze；validate 写入后 dashboard analysisStatus 未投影 base_published，需修复服务器侧 bridge/projection 后重跑。
- compatibility:
  - preserve existing Skill public_id and baseline platform fields.
  - read/process do not read/write AIWAN server.
  - analyze is read-only; validate owns final write.
  - server bridge only publishes analysis_result.display_insights.
  - preserve v30 Python PROCESS OOM fixes, full6 compatibility, display_insights and validate write/reread behavior.
- verification scenario: 已执行 disabled trial-run 多 tick：4 SQL 只提交一次且 execute_id/CAS 恢复，materialize/process/analyze 完成；当前阻断在 validate 写后 dashboard base_published 复读和 ready handoff，修复服务器侧投影后必须重跑。
