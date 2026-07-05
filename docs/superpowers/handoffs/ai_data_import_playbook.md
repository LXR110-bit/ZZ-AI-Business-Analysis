# AI 数据导入 Playbook · 机型周数据 pipeline 完整方法论

> **作者**：ai数据导入 Agent（8 段深度知识）+ 主控（§0/§9/§10 收敛）
> **产出时间**：2026-07-05
> **版本**:v1.0
> **状态**：可执行,W27 daily 补跑实战验证

## 为什么有这个文档

**用户诉求**：这个链路踩过很多坑，问题反复出现，要固化成方法论。

**踩过的核心坑**（不完整列表，详见 §3）：
- csv-put async commit 延迟造成 spot-check 假报警（连续多次误判 pipeline 失败）
- dim-delete 尾部残留 100 行（rc 178208 vs 真数据到 178108）
- 双 pipeline 同时写同一表（手动跑撞上 09:30 cron）
- verify tolerated batches 假报警（44 个 tolerated 全是数据已落盘）
- 中途 kill 后 clear-weeks 状态不可恢复
- batch=1000 服务端 timeout 率过高

**本 playbook 目标**：任何新 sub-agent / 用户接这条链路,**5 分钟读完能上手**,**不重复踩上述坑**。

---

## §0 快速上手（30 秒摘要）

**这条 pipeline 做什么**：
1. IMAP 抓 AI 小万系统每日邮件 zip
2. pandas load + aggregate by week
3. `lark-cli sheets +csv-put` 写飞书 2 个 spreadsheet 共 10 tab（summary 5 + daily 5）
4. cron 每天 09:30 触发，端到端 2.5-5 小时

**唯一入口**：`skills/workflows/机型周数据/pipeline.py`

**手动跑的 3 条铁律**：
1. **起 pipeline 前必查** `ps aux | grep 机型周数据` —— 双 pipeline 撞车会毁数据
2. **手动窗口** = 14:00 至次日 09:00（避开 09:30 cron 及其 2.5-5h 运行窗口）
3. **假报警识别** = tolerated 报告后**等 30-60s**再 csv-get 验证，绝大多数是数据已落盘

**当前生产参数**：`CSV_PUT_BATCH=300` / `CSV_PUT_RETRY=5`（稳定优先，实测 44 个 tolerated 全是假报警）

**遇到问题的第一站**：
- pipeline 报 tolerated → §3 坑 1 + §7 判定标准
- rc 对不上 → §3 坑 2 + §6 dim-delete SOP
- kill 后不知怎么恢复 → §3 坑 5 + §6 断点续跑

---

## §1 数据链路全景

```
IMAP zip 邮件（AI 小万系统日发）
  ↓ IMAP 拉取（pipeline.py 内部，lookback_days=14）
  ↓ 本地缓存 /tmp/机型周数据_zip_cache
  ↓ pandas load raw → split by month
  ↓ aggregate_by_week（机型/成色/履约维度分组）
  ↓ 只保留 latest_week
  ↓ upsert_tab（每 tab 独立）:
      _clear_tail_week（tail-fast：末尾 5000 行匹配 week 列删除）
        or _clear_rows_matching_weeks（全表扫，慢 fallback）
      _last_data_row → _ensure_capacity → _csv_put_batched
      _shrink_trailing_empty（删末尾空行，保 SHRINK_BUFFER=500）
  ↓ notifier 飞书群
```

**关键实现细节**：
- **IMAP 抓 zip**：pipeline 内嵌，cron 触发时同步拉，非独立 daemon
- **cron 触发**：`30 9 * * *` = 每日 09:30，summary + daily 两 spreadsheet 共 10 tab
- **upsert_tab 底层**：`lark-cli sheets +csv-put`（非 append）
- **端到端时间**：2.5-5 小时（e2676a 小表 30-60min/tab，7rBBpo 170k+ rows 大表 60-90min/tab）

**权威源码位置**：
- `skills/workflows/机型周数据/pipeline.py` L51/55/808/816（`upsert_tab` 调用点）
- `constants.py`（`SUMMARY_TOKENS` / `DAILY_AVG_TOKENS`）

---

## §2 关键参数矩阵

| 参数 | 当前值 | 试过的值 | 说明 |
|------|--------|---------|------|
| `CSV_PUT_BATCH` | **300** | 500（timeout 率高）/ 1000（几乎必 timeout） | 服务端 timeout 阈值 ~14s；300 单 batch ≈ 10-15s 安全区 |
| `CSV_PUT_RETRY` | **5** | 2（不够）/ 3（边界） | async commit 落盘 5-30s，retry 5 次带 backoff（1→2→4→8→16=31s 窗口）覆盖 |
| `CSV_PUT_RETRY_BACKOFF` | **1** | 固定 | 指数退避基数，sleep = `BACKOFF × 2^attempt` |
| `SHRINK_BUFFER` | **500** | — | shrink 保留末尾空行，防频繁扩缩容 |
| `DIM_DELETE_BATCH` | **5000** | — | dim-delete 单次上限 |
| `MONTH_CONCURRENCY` | **4** | — | 月并发（单月无用） |
| `CSV_GET_ROW_BATCH` | **500** | — | csv-get 单次上限 |

**参数决策矩阵**：
- 稳定优先 → `batch↓ retry↑`（300/5，当前配置，实测 tolerated 全是假报警）
- 速度优先 → `batch↑ retry↓`（1000/2，10 min 完成但假报警多且真丢失风险）
- **警告**：假报警根因是 **verify 逻辑**，不是参数。参数调完还是会假报警，Phase 1（§8）修 verify 才是根治。

**改参数的铁律（工程原则）**：
- **一次只动一个参数**，问题好定位
- 改完必须端到端跑一次 + 记录 tolerated 数 + 手动验证是否假报警
- 参数改动**同步更新本 §2 表格 + 决策记录 commit**

---

## §3 已知踩过的坑（症状 / 根因 / 修法 / 教训）

### 坑 1：csv-put async commit 延迟 → spot-check 假报警（2026-07-05 诊断）

- **症状**：pipeline 报 `csv-put tolerated batches lost data at rows: [131924, ...]`，手动 csv-get 数据存在
- **根因**：client timeout（14s）后服务端 async commit 仍在提交，pipeline 立刻读 → 尚未落盘 → 判失败
- **修法**：spot-check 加 `sleep + 单行 retry`（Phase 1 方案 B，§8）
- **教训**：**判定幂等操作"失败"前必须给 server async commit 时间窗口**

### 坑 2：dim-delete 尾部残留（rc 178208 vs 数据到 178108）

- **症状**：kill 后 `_shrink_trailing_empty` 未执行完 → rc 残留；下次 tail-fast 从错误 rc 起扫 → 匹配旧周残留行
- **根因**：shrink 是 non-fatal try，失败不影响数据但污染 rc
- **修法**：手动 `dim-delete --range {真尾+1}:{rc}`
- **教训**：**rc ≠ 数据结尾**，csv-get A 列扫描找真尾

### 坑 3：双 pipeline 同时写（2026-07-05 10:17）

- **症状**：手动跑 pipeline 和 09:30 cron 同时对 6725f1 做 clear-weeks + csv-put → 行号错乱
- **根因**：pipeline 无锁
- **修法**：起 pipeline 前必查 `ps aux | grep 机型周数据`
- **教训**：**pipeline 必须单例**，未来加 flock（Phase 3，§8）

### 坑 4：verify tolerated 假报警

- 同坑 1，连续多次假报警 = 系统性设计缺陷
- **实测**：2026-07-05 44 个 tolerated 全是数据已落盘

### 坑 5：中途 kill 后 clear-weeks 状态不可恢复

- **症状**：kill 在 seg 38/56 → 部分行已删部分未删 → 下次 tail-fast 用错误起点
- **根因**：clear-weeks 无 checkpoint
- **修法**：从 log 找最后 seg 手动补删，或接受下次 cron 自愈（cron 幂等）
- **教训**：**破坏性操作必须有 checkpoint 或可从 log 精确恢复**（Phase 4，§8）

### 坑 6：batch=1000 服务端 timeout 高

- **症状**：早期每 5 batch 就 timeout 1 次，tolerated 堆积到 40+
- **根因**：服务端 14s timeout，1000 rows 处理 15-30s
- **修法**：调 batch=300（单 batch 10-15s 安全区）
- **教训**：**server timeout 阈值决定 batch 上限**

### 坑 7：`_shrink_trailing_empty` 有 `keep_until_row + SHRINK_BUFFER` 兜底

- **症状**：清理后 rc 仍比真数据多 500
- **根因**：这是**设计**不是 bug，防频繁扩缩容
- **教训**：spot-check 时**不要**误把 SHRINK_BUFFER 空行当"数据丢失"

---

## §4 每个终点表的特性

**Summary 表**（`spreadsheet_token = TzkVs1LVshLaZjtH1nzcG4opnxb`，2026-06）：幂等 clear + 全写

| sheet_id | 名字 | 期望 rc（W27 后） | 特点 |
|----------|-----|-----------------|------|
| 6725f1 | 日期机型维度 | 178108 | 最简，机型级 |
| 7rBBpo | 机型核心属性成色 | 272222 | 最大，csv-put 最耗时 |
| 053Pci | 机型履约 | 82112 | 小 |
| VsIzPj | 核心属性+成色+履约 | 160719 | 3 维叠加中大 |
| B0ZJKk | 机型质检成交 | 166114 | 中，少 metric |
| U4MuPg / IlwtvV | 7rBBpo 的 p2/p3 分页备份 | 272222 / 50138 | 分页备份 |

**Daily 表**（`spreadsheet_token = FRxvsYBZWhsN7QtXGFMc7WOVnyb`，2026-06）：同结构

| summary sid | daily sid |
|-------------|-----------|
| 6725f1 | e2676a |
| 7rBBpo | oVpEk4 |
| 053Pci | 1HcKTj |
| VsIzPj | ulcnkm |
| B0ZJKk | F2h1jv |

**Spot-check 硬校验三步**：
1. `sheets +workbook-info` 拿 `row_count`（简称 rc）
2. `sheets +csv-get A{rc-20}:A{rc}` 看尾部是否 latest_week
3. 尾部有旧周（如 W23 在 W27 后）→ shrink 未清干净 → dim-delete 修复

---

## §5 cron 已知调度

| Cron | 时刻 | 执行 | 端到端 |
|------|------|------|--------|
| `30 9 * * *` | 每日 09:30 | `机型周数据_cron.sh → python3 -m skills.workflows.机型周数据 --lookback-days 14` | 2.5-5h（summary + daily 共 10 tab） |

**重叠风险**：
- cron 09:30 vs 手动跑：早 10:30 起手动跑大概率还在 cron clear-weeks 阶段 → **撞车**
- 建议手动窗口：**14:00 - 次日 09:00**（cron 结束后到下次开始前）
- summary 和 daily 是**不同 spreadsheet**，不互锁（可以分别独立手动跑单个）

**重叠风险矩阵**：

| 场景 | 是否安全 | 说明 |
|------|--------|------|
| 手动跑 summary + cron 跑 summary | ❌ 撞车 | 同 spreadsheet |
| 手动跑 daily + cron 跑 summary | ✅ 安全 | 不同 spreadsheet |
| 手动跑 daily 单个 tab + cron 跑 daily | ⚠️ 高风险 | 同 spreadsheet 同 tab 撞车 |
| 手动跑 09:30 之前完成（比如凌晨 6 点起） | ✅ 安全 | 手动 3h 完成，能 9:30 前收尾 |

---

## §6 手动干预 SOP

### 预检（起 pipeline 前必做三步）

```bash
# 1. 有没有 pipeline 在跑
ssh zz-server 'sudo -n ps aux | grep -E "python.*机型周数据|python.*run_daily_only" | grep -v grep'

# 2. 离 09:30 cron 多久
date  # 若 06:00-09:30 之间，不建议起

# 3. 基线 rc（用来最后交叉对拍）
ssh zz-server 'sudo -n bash -c "set -a; source /root/secrets/.env; set +a; lark-cli sheets +workbook-info --spreadsheet-token TzkVs1LVshLaZjtH1nzcG4opnxb --as bot"'
```

### 手动补跑（全表）

```bash
ssh zz-server 'sudo -n bash -c "
  set -a; source /root/secrets/.env; set +a
  cd /root/workspace/ZZ-AI-Business-Analysis
  nohup python3 -m skills.workflows.机型周数据 --months 2026-06 --skip-notify \
    > /root/logs/manual_$(date +%Y%m%d_%H%M%S).log 2>&1 &
"'
```

### 手动补跑（只跑 daily）

```bash
# 用 monkey-patch summary_token_for → None 跳过 summary
# 见 /tmp/run_daily_only.py（临时脚本，不入 git）
```

### Kill 后断点续跑

1. **从 log tail 找 kill 时进度**（clear-weeks seg X/N 或 csv-put batch X/N）
2. **卡 clear-weeks 阶段** → 直接重跑 pipeline（幂等，重跑不污染）
3. **卡 csv-put 中段** → 手动 dim-delete 未写入尾行，再重跑
4. **shrink 未执行** → 手动 dim-delete rc 尾部（见 §3 坑 2）

### dim-delete 尾部残留正确姿势

```bash
# 1. 拿当前 rc
CURRENT_RC=$(lark-cli sheets +workbook-info ... | jq '.data.sheets[] | select(.sheet_id=="6725f1") | .row_count')

# 2. 用 csv-get 找真尾（A 列扫描到最后一个非空且是 latest_week 的行）
lark-cli sheets +csv-get --sheet-id 6725f1 --range "A${CURRENT_RC}:A${CURRENT_RC}" --as bot
# 逐行往前找，直到值 = latest_week（如 2026-W27）

# 3. dim-delete 从"真尾+1"到当前 rc
REAL_TAIL=178108  # 假设找到真尾在这里
lark-cli sheets +dim-delete --sheet-id 6725f1 --range "$((REAL_TAIL+1)):${CURRENT_RC}" --as bot
```

---

## §7 spot-check 硬校验命令模板

### rc 查询（所有 tab 一次拿）

```bash
ssh zz-server 'sudo -n bash -c "set -a; source /root/secrets/.env; set +a;
  lark-cli sheets +workbook-info --spreadsheet-token TOKEN --as bot"' | python3 -c "
import sys, json
d = json.load(sys.stdin)
for s in d['data']['sheets']:
    print(f\"{s['sheet_id']} rc={s['row_count']}\")
"
```

### 尾部 20 行

```bash
lark-cli sheets +csv-get --spreadsheet-token TOKEN --sheet-id SID \
  --range "A${rc_minus_20}:A${rc}" --as bot
# 期望：全是 latest_week；有旧周 → shrink 未清干净
```

### 交叉对拍（summary vs daily）

- Summary 存每天明细，daily 存每周日均（数值 / 7）
- 关系粗略：`daily rc ≈ summary rc / 7`
- 严格：daily 每机型每周 1 行 vs summary 每机型每周 7 行

### 假报警 vs 真丢失判定（核心资产）

1. pipeline 报 `csv-put tolerated batches lost data at rows: [R1, R2, ...]`
2. **等 30-60s**（关键，async commit 落盘窗口）
3. 手动 `csv-get A{R1}:A{R1}`：
   - 返回值非空且是 latest_week → **假报警，数据已写**
   - 返回值空 → **真丢失，重跑该 batch**
4. **实测 2026-07-05**：44 个 tolerated **全是假报警**，数据 100% 存在

**这个判定标准是本 playbook 最重要的资产**。误判真丢失为假报警会漏数据，误判假报警为真丢失会盲目重跑污染幂等状态。

---

## §8 未来改进方向

### Phase 1：修 verify 逻辑（**优先**）

- **方案**：15 行 `sleep + retry`，同步改 spot-check + FINAL verify
- **技术要点**：
  - 每个 tolerated batch 首行读到空 → `sleep 10s` → 重读，最多 3 次
  - 附带 mock `sheets_csv_get` regression test（前几次返回空、后面真数据，verify 应通过）
  - 推荐指数退避（`10s → 15s → 25s`），系统压力大时给更多时间
- **验证**：daily pipeline 跑完拿到实测数据后起 PR

### Phase 2：参数动态化

- 滑动窗口 latency 采样，`>12s` → `batch↓`，`<8s` → `batch↑`
- 自适应替代人工调参
- 需要 metrics 采集基础（Phase 6 前置）

### Phase 3：Pipeline 单例锁

- `flock /var/run/机型周数据.lock`
- 防坑 3（双 pipeline 撞车）
- 简单，5 行 shell 改动

### Phase 4：Clear-weeks / csv-put checkpoint

- 每 seg 写 `.progress.json`
- 防坑 5（kill 后断点续跑）
- 中等改动，需重构 clear-weeks 逻辑

### Phase 5：pipeline.py git 化（**当前阻塞项**）

- 当前在 `/root/workspace/...` 直接改，不受版本控制
- 需 CI + 部署脚本
- **阻塞在**：没有 IMAP + lark 集成测试环境（真实凭据不能进 CI）
- 中期方案：git 化 + mock 集成测试 + 手动部署脚本

### Phase 6：端到端 monitor

- Grafana 面板：cron 时长 / timeout 率 / tolerated 数 / **假报警 vs 真丢失比例**
- 告警规则：**真丢失 > 0 才告警**（避免假报警噪音）
- 依赖：Phase 1 修完 verify 后才有"真丢失"这个 metric 意义

---

## §9 SOP 快速索引

**"我要手动补跑一次"** → §6 预检三步 + 手动补跑

**"pipeline 报 tolerated batches lost data"** → §7 假报警 vs 真丢失判定（**等 30-60s 再验证**）

**"rc 对不上"** → §3 坑 2 + §6 dim-delete 尾部残留

**"pipeline 被 kill 了"** → §6 断点续跑（先看 log 判定卡在哪个阶段）

**"要改参数"** → §2 参数决策矩阵 + 改参数铁律（一次一个 + 端到端验证 + 更新表格）

**"新表加入 pipeline"** → §4 加行 + §7 spot-check 命令套用

**"cron 调度变化"** → §5 更新表格 + §5 重叠风险矩阵

**"改 verify 逻辑"** → §8 Phase 1（当前最高优先级改进项）

---

## §10 教训固化引用（对齐主控 bootstrap）

本 playbook 涉及的教训与主控 `master_agent_bootstrap.md` 教训章节的对应关系：

| 本 playbook 内容 | 对应主控铁律 |
|-----------------|-------------|
| §3 坑 1 假报警诊断 = "等 30-60s 再判定" | 教训 5 · 客观信号 > 自陈（等落盘再验证） |
| §7 假报警 vs 真丢失判定 | 教训 5 子铁律 · 契约验证要查期望值 |
| §3 坑 3 双 pipeline 撞车 | 教训 5 客观信号（`ps aux` 先查再动） |
| §2 参数决策矩阵 + 一次只动一个 | 教训 1 · Edit + git 串行同源（一次改一件事） |
| §6 手动干预 SOP + §9 索引 | 教训 7 · 分工边界（Sub-agent 能自查文档不打扰主控） |
| §8 Phase 1 verify 修法 | 教训 6 · 归一化必须挂数据出口最后一站（同源思想：判定必须给完整时间窗） |

**未来接入这条 pipeline 的 sub-agent 必读顺序**：
1. 本 playbook §0（30 秒摘要）
2. 主控 `master_agent_bootstrap.md`（分工边界 + 沟通节奏）
3. `frontend_deploy_playbook.md`（部署 SOP 通用模式，本 playbook 是同结构）

---

## 版本历史

| 版本 | 日期 | 更新 |
|------|------|------|
| v1.0 | 2026-07-05 | 首版，ai数据导入 Agent 8 段深度知识 + 主控收敛 §0/§9/§10 |

**下次更新触发**：
- Phase 1 verify 修法上线 → §2 参数矩阵表格更新
- 新表加入 pipeline → §4 行更新
- cron 调度变化 → §5 更新
- 新踩到坑 → §3 追加
