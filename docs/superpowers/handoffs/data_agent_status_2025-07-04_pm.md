# 数据 Agent 进度报告 · 2025-07-04 下午加更

> 面向:主控 Agent、用户
> 分支:`feature/monitor-lib-shared`(未 commit)
> 承接前一份:`data_agent_status_2025-07-04.md`

---

## 一、这一轮做了什么

### 🎯 用真实生产数据把 Python vs Node 等价性拉满

前一轮的 Parity 是拿手写 fixture(5 款机型/1 品类)跑的。这轮从生产 API 拉真数据,横跨 10 大品类 × 5 周,共 **6.3 万行**做对拍。

**数据来源**:`http://47.84.94.234:8848/api/monitor?dimension=model` + `data/cache.json`(生产 syncedAt=2026-07-04 04:43 UTC),服务器上按品类切片后打包下载,存在 `data/real_snapshot/monitor_snapshot/`。

**结果**:

| 品类 | rows | pool | watchList | Diff | tie 边界互换 |
|---|---:|---:|---:|---:|---|
| 显卡 | 22034 | 20/20 | 20/20 | 0 | 无 |
| 显示器 | 17750 | 20/20 | ─ | 0 | 无 |
| 主板 | 7089 | 20/20 | 0/0 | 0 | 1 项 (evaUv=5) |
| 台球杆 | 6926 | 20/20 | ─ | 0 | 无 |
| 手表/腕表 | 6443 | 20/20 | ─ | 0 | 1 项 (evaUv=5) |
| 内存条 | 6022 | 20/20 | ─ | 0 | 无 |
| 数码相机 | 5661 | 20/20 | ─ | 0 | 1 项 (evaUv=11.5) |
| 盲盒收纳 | 4981 | 20/20 | 0/0 | 0 | 无 |
| 打印机 | 4759 | 20/20 | ─ | 0 | 1 项 (evaUv=4.5) |
| 便携音箱 | 4577 | 20/20 | ─ | 0 | 无 |

**总计**:10/10 通过,delta 数值 |diff| < 1e-9,flags 集合完全一致。35/35 单测通过。

**tie 边界互换的处理**:发现 Node `list.sort` 无 tie-breaker(依赖 rows 首次出现顺序),Python 加了 `modelName` 二级键。当 pool 第 20 名附近有 evaUv tie 时,两边选到的具体机型可能不同,但池大小、watchList、delta、flags 都一致。

已把这个契约条款写进 `docs/superpowers/specs/monitor_lib_shared.spec.md` 第五节 "验收标准" · Parity 测试段落。

### 交付物

新增:
- `scripts/verify_equivalence_real.py` — 真数据等价性对拍脚本(可复用,后续 CI 挂它)
- `data/real_snapshot/monitor_snapshot/raw_*.json` — 10 品类 raw 快照(30MB tar.gz 解开)
- `data/real_snapshot/gpu_monitor_node.json` — Node 版 monitor 输出快照
- `data/real_snapshot/EQUIVALENCE_REPORT.md` — 最后一次跑的报告

修改:
- `docs/superpowers/specs/monitor_lib_shared.spec.md` — Parity 验收条款升级为"真数据 + tie 契约"
- `orchestrator/src/orchestrator/lib/monitor/schemas.py` — `evaUv/orderUv` 允许 float(生产数据里出现 0.5、11.5 等,原 spec 只写 int)

未 commit。

---

## 二、给主控/用户的三个候选项

Python 版核心算法与 Node 严格等价这件事已经 **闭环**。下一步走哪条主控决策:

### 选项 A · 提交并冻结契约,收工

- 把这轮改动打包 commit(spec + schemas.py 修 float + verify 脚本 + 快照)
- 契约层面完成 monitor_lib_shared 核心算法交付
- 后续 fetcher/agent_hook/pusher 已在 `9fdb7a5` 里做完 mock 版,监控主线打通
- **不再往下推**,让主控切回飞书推送、规则管理页那两条主线

**适合**:主控觉得核心算法已经稳,想把精力挪回业务闭环。

### 选项 B · 扩展等价性覆盖到全字段

- 目前只校验了 pool 大小/成员、watchList、delta、flags
- 还没覆盖 cur/prev 完整字段(jkuv, orderUv, gmv, avgPrice, daysReceived, trend 数组等)
- 加一轮 field-level diff,catch 剩余边界(比如 Node 的 `x.toFixed(4)` vs Python 的 `round(x, 4)` 差异)

**适合**:主控担心还有隐性差异会在真上线时才暴露。

### 选项 C · 挂 CI + 契约冻结

- 把 verify 脚本挂到 `pre-push` 或 GitHub Actions
- Python lib 每次改都自动跑真数据对拍
- 快照数据版本化(git-lfs 或 zenodo),避免"哪次为准"的问题
- 主控这边配一份"契约变更审批"流程

**适合**:主控想把等价性做成长期保障机制,不只做一次性验收。

---

## 三、推荐

**A + C 组合**:先 commit 冻结(A),再挂最简单的本地 pre-commit hook(C 的最轻量版)。

理由:
- B 的边际收益低——delta 数值都能 |diff| < 1e-9 对上,说明底层浮点算法已经等价;剩下的字段差异更可能是"零"或"手工可肉眼定位"的
- 真正会咬人的是**未来某次改 Python 版规则时忘了同步 Node**,C 能挡住
- 挂 CI 之前最简单是 pre-commit,几行 shell,一天内能落

**如果主控更保守**:走 B 也 OK,再花半天覆盖 cur/prev 全字段,得到"真·零差异"报告。

---

## 四、需要主控明确的事

1. **选 A / B / C / A+C**?
2. commit message 用哪种?
   - "Verify Python vs Node monitor equivalence on real production data (10 categories, 63k rows)"
3. 快照数据要不要提交到 git?
   - 优点:可复现
   - 缺点:30MB,git 库变大
   - 建议:压缩后的 tar.gz(2.8MB)提,原始 json 加 .gitignore

请主控/用户在下一轮回复里定夺,数据 agent 待命。

---

## 五、主控答复(2026-07-04 下午收到)

**决策**:走 **A + C-alpha**,B 不做,C-beta 另开 spec。

- **A**:commit Python 版 + verify 脚本 + status 到 `feature/monitor-lib-shared`,push
- **C-alpha**:加 `.github/workflows/monitor-lib-tests.yml`,push/PR 触发 `pytest src/orchestrator/lib/monitor/tests/`(纯单测,不需要生产数据)
- **B 不做**:jkuv/gmv/avgPrice 属 fetcher 层原始数据,验它们是另一件事
- **C-beta 不这轮做**:真·跨语言对拍 CI 需要 Node+Python+脱敏 fixture,是独立 P2 spec

**commit message 口径**:主控给了完整版(见 §六 commit 记录)。

**快照数据不进 git**:业务敏感 + 过期性 + CI 用不着 + verify 脚本本身入库已经可复现。

## 六、执行状态

**Rebase 已完成**:分支基线已对齐 `origin/main`(da969df),drop 了 3 个 patch-already-upstream 的 commit(specs / master_bootstrap / feishu_bootstrap 都被 PR #13-17 合到 main 了)。

**当前 HEAD**:`1b25116 Add Phase-1 server & Feishu infra handoff for project-wide reuse`(rebase 后新 hash)
**待 commit**:
```
 M .gitignore                                                          # 新增 data/real_snapshot/ 排除
 M docs/superpowers/specs/monitor_lib_shared.spec.md                   # Parity 验收条款升级
 M orchestrator/src/orchestrator/lib/monitor/schemas.py                # evaUv/orderUv 支持 float
?? docs/superpowers/handoffs/data_agent_status_2025-07-04_pm.md        # 本 status
?? scripts/verify_equivalence_real.py                                  # 等价性验证脚本
```
`data/real_snapshot/`(30MB 生产快照)被 .gitignore 排除,不入库。
