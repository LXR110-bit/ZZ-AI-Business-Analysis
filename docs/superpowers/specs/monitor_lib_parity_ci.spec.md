# Spec · monitor_lib_parity_ci

> **状态**：设计定稿，实施待启动
> **优先级**：P2（monitor_lib_shared 稳定后启动）
> **归属**：`.github/workflows/monitor-lib-parity.yml` + `orchestrator/src/orchestrator/lib/monitor/tests/parity/`
> **作者**：主控
> **最后更新**：2026-07-04

---

## 一、目的

**长期保障 Python 版 `monitor_lib_shared` 跟服务器 Node 版 `model-tag-monitor` 的算法等价性**，防止任一侧改动后另一侧忘同步导致数据看板跟归因分析结果分叉。

**背景**：数据 Agent 在 W27 完成 Python 版实现时，用真实生产数据（10 品类 × 5 周 × 63k 行 raw）跑过一次性对拍，10/10 品类 pool/watch/delta/flags 全等、delta 精度 |diff| < 1e-9。这次是一次性证据，**没有长期防护**。

**痛点场景**：
1. 未来某天数据 Agent 优化 Python 版 wave 算法（比如换 tie-breaker），忘同步 Node 版
2. 前端 Agent 在 Node 版加了一个 flag（比如 `isNewModel`），Python 版没跟上
3. 有人调 rules 阈值（`waveThreshold` 从 0.1 改到 0.15）只改了一边

以上任一发生，dashboard 显示的 Top 10 跟归因分析用的 pool 就会分叉。**没 CI 挡的话，只能靠人肉记着"两边都要改"**，靠不住。

**服务对象**：
- 未来任何改 `orchestrator/src/orchestrator/lib/monitor/` 或 `model-tag-monitor/src/` 算法层的 PR
- monitor_lib_shared 依赖方（`model_weekly_monitor` / `category_weekly_monitor` / dashboard 聚合）

---

## 二、能力清单

一个 GitHub Actions workflow + 一份脱敏测试 fixture + 一个对拍 runner。

### ① `.github/workflows/monitor-lib-parity.yml`

**触发条件**：

```yaml
on:
  pull_request:
    paths:
      - 'orchestrator/src/orchestrator/lib/monitor/**'
      - 'model-tag-monitor/src/**'
      - 'orchestrator/src/orchestrator/lib/monitor/tests/parity/**'
  push:
    branches: [main]
    paths:
      - 'orchestrator/src/orchestrator/lib/monitor/**'
      - 'model-tag-monitor/src/**'
```

**说明**：只有算法层或对拍夹具改动才跑，日常文档 PR 不触发。

**Job 结构**：

```yaml
jobs:
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: install python deps
        working-directory: orchestrator
        run: pip install -e .
      - name: install node deps
        working-directory: model-tag-monitor
        run: npm ci
      - name: run parity check
        working-directory: orchestrator
        run: python -m orchestrator.lib.monitor.tests.parity.runner
```

**失败行为**：`runner` 找到任一品类 pool/watch/delta/flags 不等价，非零退出，PR check 变红。

---

### ② 脱敏测试 fixture

**位置**：`orchestrator/src/orchestrator/lib/monitor/tests/parity/fixture/`

**结构**：

```
fixture/
├── funnel_rows.json          # 5 品类 × 5 周 × ~200 机型的模拟漏斗数据
├── rules.json                # 完整 MonitorRules（含 poolTopN / waveThreshold / trendWeeks / minEvaUv / rates）
└── expected_note.md          # 说明这份 fixture 覆盖哪些边界场景
```

**设计原则**：

1. **完全脱敏**：品类名用 `category-A / category-B / ...`，机型名用 `model-{i:04d}`，UV/GMV 用合成数据（分布参考生产但完全人工构造）
2. **覆盖边界**：
   - **池边界 tie**：至少 1 组机型在 `poolTopN` 边界上 `evaUv` 相等（校验允许差异注明的行为）
   - **null delta**：至少 1 组机型 `cur.returnCnt=0 && prev.returnCnt=0` → `delta.returnRate=null`
   - **prev=null（首周）**：至少 1 组机型只在 `week_current` 出现
   - **rate=0/1 边界**：`orderCnt=0` 和 `orderCnt=evaUv` 各至少 1 组
   - **trend 连续同向**：至少 1 组机型 3 周严格同向（测 trend "up"/"down"）
   - **trend 断链**：至少 1 组机型 2 周同向、第 3 周反向（测 trend null）
3. **规模足够小可 diff**：5 品类 × 5 周 × ~200 机型 = ~5k 行，CI 5 秒内跑完，人肉能 diff 输出
4. **确定性**：不涉及随机、时间戳、机型 ID 排序等易漂移因素

**如何构造**：主控自己写生成脚本（`generate_parity_fixture.py`），产出上述 3 个文件，一次性生成后 commit 到 git，不 gitignore。生成脚本本身也进 git，方便未来补边界场景时重生成。

---

### ③ 对拍 runner

**位置**：`orchestrator/src/orchestrator/lib/monitor/tests/parity/runner.py`

**流程**：

```
1. 读 fixture/funnel_rows.json + fixture/rules.json
2. Python 侧：
   from orchestrator.lib.monitor import compute_wave, apply_rules
   py_result = { "pool": [...], "watchList": [...], "delta": {...}, "trend": {...} }
3. Node 侧：
   subprocess.run(["node", "model-tag-monitor/scripts/parity_export.js", "--fixture", "fixture/"])
   → 输出 node_result.json
4. 逐字段对比：
   - pool 集合等价（顺序无关，dim_key 组合相等）
   - watchList 集合等价 + flags 集合等价（按 dim_key 分组内比）
   - delta 逐机型 |diff| < 1e-9
   - trend 逐机型三值精确相等
5. 不等价 → 打印 diff 报告 + 非零退出
```

**Node 侧配套**（`model-tag-monitor/scripts/parity_export.js`）：

- 读同一份 fixture
- 调 `model-tag-monitor/src/wave.js` 等模块
- 输出 JSON 到 stdout（runner 捕获）

**"允许差异"处理**：

池边界 `evaUv` tie 的机型选取差异已在 `data_to_frontend_contract.md` 注明为允许差异。runner 的对比逻辑：

- pool 集合差 ≤ 1 个机型且差异机型的 `evaUv` 都等于池边界 `evaUv` → 视为**等价 with warning**（打印 warning 但不 fail）
- 否则 fail

---

## 三、验收标准

### 落地
- [ ] `.github/workflows/monitor-lib-parity.yml` 存在且能被触发
- [ ] `fixture/funnel_rows.json` / `rules.json` / `expected_note.md` 三件套齐全
- [ ] `runner.py` + `parity_export.js` 齐全
- [ ] `generate_parity_fixture.py` 齐全（未来可重生成）

### 正确
- [ ] main 分支第一次跑 workflow 是绿的（Python 版 vs Node 版当前实现等价）
- [ ] 故意在 Python 版改一个常量（比如 `waveThreshold=0.1` 改成 `0.15`），workflow 变红
- [ ] 恢复后重跑变绿

### 长期
- [ ] 未来数据 Agent 或前端 Agent 改算法层 PR，parity check 自动运行
- [ ] fixture 有 README 说明覆盖哪些边界，未来加边界时能定位漏项

---

## 四、跟其他 spec 的关系

- **依赖 `monitor_lib_shared` 已实施完成且稳定**（是它的长期保障，不是它的前置）
- **不依赖 `model_weekly_monitor` / `category_weekly_monitor`**（这两个 spec 消费 lib，parity 是保护 lib 本身）
- **不依赖 `project_status`**

---

## 五、实施策略

**谁做**：主控自己做（这是基础设施 spec，不涉及业务逻辑，主控写完直接起 PR；不派 sub-agent 避免上下文切换成本）

**何时做**：`monitor_lib_shared` PR（数据 Agent 正在做的 A + C-alpha）合并到 main、稳定 3-5 天没大改动后启动。太早做 fixture 期望值会跟随 lib 迭代反复更新，浪费。

**估工**：0.5 天
- fixture 生成脚本 + fixture 三件套：2 小时
- runner.py：1.5 小时
- parity_export.js：1 小时
- workflow yaml 调通 + 联调：1 小时
- expected_note.md + spec 微调：0.5 小时

**风险**：
- Node 侧 `parity_export.js` 需要 Node 版模块导出足够干净的接口，可能要小改 `model-tag-monitor/src/`（预期改动 < 30 行）
- CI 环境 npm ci 慢（首次可能 2-3 分钟）→ 可加 npm cache action 优化

---

## 六、暂不做

以下延展**不在本 spec 范围**，若未来需要单起新 spec：

1. **对拍生产真实数据**：一次性证据由数据 Agent 已完成，长期用脱敏 fixture 够。真数据涉及业务敏感 + 变动性大，不适合 CI
2. **性能 benchmark 对拍**：Python vs Node 性能差异不影响业务正确性，不做
3. **fetcher 层对拍**：fetcher 是 IO 层不是算法层，算法等价 ≠ IO 等价；fetcher 有自己的集成测试路径

---

## 七、参考

- `docs/superpowers/handoffs/data_agent_status_2025-07-04_pm.md`（W27 一次性等价性验证结果）
- `docs/superpowers/handoffs/data_to_frontend_contract.md`（契约 v1.0，池边界 tie 允许差异注明位置）
- `docs/superpowers/specs/monitor_lib_shared.spec.md`（本 spec 保护的对象）
