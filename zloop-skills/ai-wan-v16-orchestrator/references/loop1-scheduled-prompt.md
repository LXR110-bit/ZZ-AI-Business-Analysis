# Loop1 阶段 A 调度契约

每次调度只运行一个 `aiwan_loop1_tick.py` tick。使用 Asia/Shanghai 动态计算日期，不得在 Prompt 里硬编码 week 或日期。

```bash
RUN_DT="$(TZ=Asia/Shanghai date +%F)"
DATA_END_DATE="$(TZ=Asia/Shanghai date -d 'yesterday' +%F)"
WEEK="$(TZ=Asia/Shanghai date -d "$DATA_END_DATE" +%G-W%V)"
BASE_DEADLINE_AT="${RUN_DT}T07:10:00+08:00"

"$PYTHON_BIN" scripts/aiwan_loop1_tick.py \
  --week "$WEEK" \
  --run-dt "$RUN_DT" \
  --data-end-date "$DATA_END_DATE" \
  --base-revision 1 \
  --base-deadline-at "$BASE_DEADLINE_AT"
```

- `run_id/analysis_key/worker_id` 由脚本稳定生成。
- `pending + exit 0` 表示本 tick 正常结束，后续 tick 继续 poll。
- 调度层必须以 10 分钟节奏重复触发；仅每日 06:10 一次无法满足 60 分钟 SLA。
- 阶段 A 固定 `model_enrichment_mode=disabled`，不设 Loop2 SLA。
- 不得启用旧 full6 Loop 代替本入口。
