# Monitor 异常机型 · 信噪比治理 Plan

> **For agentic workers:** 这份 plan 描述的是**先起 spec、再实施**的两阶段动作。数据 Agent 起草 spec 后交主控评审;评审通过后主控排期,数据 Agent 或其他被指派的 agent 用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 落地实施步骤。

**Goal:** 治理"异常机型清单里大量出现量级过小的机型"这一信噪比问题——通过在 `monitor_lib_shared` 算法/规则层引入**分品类阈值 + 品类占比过滤**,让 watchList 只保留业务上真正值得关注的机型,不动前端展示层。

**Non-Goals(本 plan 明确不做的):**
- 不做前端 filter UI(避免"前端过滤后总数跟后端对不上"这类一致性问题;信噪比在数据层根治)
- 不引入"S/A/B 机型分档"这类需要业务方 offline 打标的长期方案(那是未来 P3,超出本 plan 范围)
- 不改契约字段结构 —— `WaveReport` schema 不变,仅新增可选 rules 字段,前端零改动

**Architecture:**
- 阶段 1:数据 Agent 起草 `docs/superpowers/specs/monitor_noise_reduction.spec.md`,详列问题证据、算法修改点、rules schema 扩展、验证方式
- 阶段 2(等主控评审 + 排期后启动):按 spec 落地代码修改 + 测试 + 真实数据对拍
- 分支:阶段 1 直接推 main;阶段 2 走新 feature branch(名字待主控派活时定)

---

## 一、问题证据(必读)

数据 Agent 用今天已有的 `data/real_snapshot/monitor_snapshot`(10 品类 × 5 周)跑了一遍当前默认 rules(`poolTopN=20, minEvaUv=15, waveThreshold=0.1`),得到:

**每品类 pool 里 evaUv 分布**:

```
品类              总机型  pool watch  pool_min_uv  pool_p50  pool_max
--------------------------------------------------------------------
主板             2398    20    0          5.0        6.0       11.5
便携/无线音箱      1283    20   20         15.0       32.5     122.5
内存条            1448    20   20         20.0       36.5     159.5
台球杆            1685    20   20         42.5       58.0     162.5
手表/腕表          2573    20    6          5.0       10.5      64.5
打印机/复印机       1416    20    2          4.5        6.5      26.5
数码相机           1355    20   14         11.5       21.0     103.5
显卡             6155    20   20         18.0       23.5      65.0
显示器            4800    20   20         21.0       27.0      57.5
盲盒收纳           1950    20    0          0.5        0.5       0.5
--------------------------------------------------------------------
合计:                200 watch=122
```

**watch 按 evaUv 分桶**:

```
   <20 :  12  (10%)
 20-50 :  79  (65%)
50-100 :  24  (20%)
100-500:   7  ( 6%)
 >=500 :   0  ( 0%)   ← 一个都没有!
```

**结论 1**:当前 122 个"异常机型"里 **95% evaUv < 100**,严重信噪比失衡。

**结论 2**:品类量级差异巨大 —— 盲盒收纳品类总 evaUv 只有 12(全品类合计),vs 台球杆 4980,相差 400 倍。**同一个 `minEvaUv` 全局阈值不可能一刀切合理**。

**结论 3**:当前 `poolTopN=20` 硬规定"每品类都取 top20"是问题的直接来源:大品类 top20 都是量级充足的,小品类 top20 尾部会掉到 evaUv=0.5 这种荒谬水平。

**结论 4**:全局调 `minEvaUv` 会让部分品类"整个消失":`minEvaUv=100` 时全部 watch 只剩 7 个,`minEvaUv=200` 时 watch=0。太严了。

**参考验证脚本**(阶段 2 会入库,当前仅本地跑):跑法见 spec §六。

---

## 二、方向定位(用户 2026-07-04 确认)

| 问题 | 用户决定 |
|---|---|
| spec 核心目标 | **提高信噪比(过滤误报)** —— 不做"分级监控"这种长期演进 |
| "重要品类"由谁定 | **放到规则配置里** —— `rules.json` 支持业务方后台可视化编辑 |
| 验证数据 | **复用今天的 real_snapshot**(10 品类 63k 行) |
| 执行分工 | **数据 Agent 起 spec,交主控排期** |

---

## 三、Spec 交付物(阶段 1)

### 文件 · `docs/superpowers/specs/monitor_noise_reduction.spec.md`

**结构参考** `monitor_lib_parity_ci.spec.md`(2026-07-04 主控写的 208 行版本,是最新的 spec 结构范式)。

**必须包含的章节**:

- [ ] **一、目的** —— 用真实数据(§一的表和分桶)锚定问题严重度,不要抽象描述
- [ ] **二、能力清单** —— 三个具体动作:
  1. `MonitorRules` 新增 `minEvaUvPct` 字段(品类占比过滤)
  2. `MonitorRules` 新增 `perCategoryMinEvaUv` 字段(分品类绝对阈值,dict 结构)
  3. `detect_flags` 中的分母保护从"单一全局 `minEvaUv`"改为"三级 fallback:perCategoryMinEvaUv[cat] || cat_total * minEvaUvPct || minEvaUv"
- [ ] **三、Rules Schema 扩展**(带 JSON 例子)
- [ ] **四、算法改动点**(引用具体代码位置,`rules.py:92`)
- [ ] **五、Node 版同步策略** —— Python 改完后 Node 版也要跟(触发 parity_ci 保护),明确"这次改动要一次两侧同 PR"
- [ ] **六、验证方式**
  - 单测:新增 `test_rules.py::test_detect_flags_three_tier_min_evauv` 覆盖三级 fallback
  - 真实数据对拍:跑 real_snapshot,预期 watch 数从 122 降到 <30(具体目标值 spec 里定)
  - Node 等价性:两侧同改后跑一次 `verify_equivalence_real.py`,`|diff| < 1e-9`
- [ ] **七、契约影响** —— `WaveReport.rules` 会多出两个可选字段;前端不用改,但可以在"规则说明"面板加展示(可选)
- [ ] **八、部署考量** —— 现有 `data/rules.json` 加字段兼容:字段缺省时行为等同当前(minEvaUv=15 生效)
- [ ] **九、交付边界** —— 明确本 spec 不做的事(见 plan Non-Goals),避免主控/其他 agent 误解为"顺手改 UI"

### 起草规约

- **命名一致性**:字段名严格 camelCase,跟 schemas.py 已有约定一致
- **默认值**:所有新字段必须给"关闭此特性"的默认值(`minEvaUvPct=None`, `perCategoryMinEvaUv={}`),保证不加 rules.json override 时行为不变
- **数据引用**:§一的证据表可以整段搬进 spec,并加上"数据来源: `data/real_snapshot/`, 2026-07-04 数据 agent 跑一次生成"

---

## 四、实施步骤(阶段 2 · 主控排期后启动)

以下步骤是给"届时被派活的 agent"用的。**当前 plan 阶段 1 只交付 spec,不动这些步骤**。

- [ ] **Step 1:** 主控派活,数据 agent 或其他 agent 起分支 `feature/monitor-noise-reduction`,从最新 main 起
- [ ] **Step 2:** 按 spec §三 扩展 `schemas.py::MonitorRules`,加 `minEvaUvPct` / `perCategoryMinEvaUv` 两字段(camelCase,pydantic Field,含默认值和 description)
- [ ] **Step 3:** 按 spec §四 修改 `rules.py::detect_flags`,把 §92 行的 `wave.cur.evaUv < rules.minEvaUv` 改为三级 fallback 判定;抽出 helper `_effective_min_evauv(cat, cat_total, rules)` 便于单测
- [ ] **Step 4:** 单测 `orchestrator/src/orchestrator/lib/monitor/tests/test_rules.py` 新增三个 case:
  - `test_effective_min_evauv_per_category_wins` —— 品类白名单优先
  - `test_effective_min_evauv_pct_fallback` —— 白名单没配时走占比
  - `test_effective_min_evauv_global_fallback` —— 都没配时走全局 minEvaUv
- [ ] **Step 5:** 跑 `pytest src/orchestrator/lib/monitor/tests/ -v`,预期 35+3=38 全绿
- [ ] **Step 6:** 跑 `python scripts/verify_equivalence_real.py`(Node 未同步前 skip,或加参数只跑 Python 侧;spec §六 里定接口)
- [ ] **Step 7:** 同 PR 里更新 `model-tag-monitor/src/monitor.js` 加对应逻辑(参考 spec §五 的映射表);或者 Node 侧另开 PR 但**必须同 sprint 合入**,避免 parity_ci 挂
- [ ] **Step 8:** 更新 `data/rules.json`(或写一份 `rules.noise-reduction.json` example),给业务方一个可参考的配置样例
- [ ] **Step 9:** 更新 `docs/superpowers/handoffs/data_to_frontend_contract.md`,在 rules schema 里加两个新字段(前端不用改代码但字段存在)
- [ ] **Step 10:** 跑 CI(`monitor-lib-tests` + `monitor-lib-parity` 如已上线),两次绿后 PR

---

## 五、验证清单(阶段 1 只勾第一条,其余在阶段 2)

- [ ] **阶段 1:** spec 主控评审通过,签字合入 main(通过 PR 或直接推)
- [ ] 阶段 2:38+ 单测全绿
- [ ] 阶段 2:real_snapshot 跑一遍,watch 数从 122 降到目标区间(spec 里定,建议 15-30)
- [ ] 阶段 2:Node 版 parity 对拍 `|diff| < 1e-9`
- [ ] 阶段 2:业务方看一眼新 rules.json 例子,认可

---

## 六、风险与决策记录

**风险 1:业务方配 `perCategoryMinEvaUv` 时怎么办?**
- 短期:数据 agent 给"合理默认"配置(基于 real_snapshot 计算每品类 p50 evaUv,写成 default 例子)
- 长期:等规则管理页(飞书推送 agent 那条线的产物)上线后业务方自主编辑

**风险 2:改 rules 会不会破坏跟 Node 版的等价性?**
- 会,如果只改一边。所以 spec §五 强制要求"两侧同 sprint"
- parity_ci(PR #18 已合)会挡住只改一边的 PR,是这个 plan 的天然护栏

**风险 3:三级 fallback 的顺序会不会业务上有争议?**
- 优先级 `perCategoryMinEvaUv > minEvaUvPct > minEvaUv` 的设计理由:白名单最贴业务判断,占比自适应品类大小,全局是兜底
- 如果业务方偏好不同,spec §三 的顺序作为默认,但代码要留 comment 说明"如需调整这里"

**决策 · 为什么不做前端 filter?**
- 用户 2026-07-04 明确选"数据 agent 起 spec,交主控排期",意味着走后端方案
- 前端 filter 会导致"这周有 X 个异常"这类汇总数字后端跟前端对不上;未来 AI 归因、飞书周报都会分叉
- 前端只做展示,业务规则统一在后端 —— 这符合项目"数据契约驱动"原则

**决策 · 为什么用"占比 + 白名单"而不是"直接抬 minEvaUv"?**
- 数据实锤:抬到 200,全部 10 品类的 watch 直接归零,失去意义
- 品类量级差 400 倍时,单一阈值没有合理值
- 占比(`minEvaUvPct`)自动适配品类大小;白名单(`perCategoryMinEvaUv`)给业务方最后一刀

---

## 七、时间盒

- **阶段 1(起 spec):** ~1 小时,数据 agent 本 session 内完成
- **阶段 2(实施):** 主控排期后启动,预估 2-3 小时(改代码 30min + 单测 30min + Node 同步 30min + 对拍 + 提 PR + CI + review 补丁)

---

## 八、Handoff 到主控

阶段 1 完成后数据 agent `send_message` 通报主控:
- spec 文件路径
- 关键决策点(三级 fallback / 不做前端 / Node 需同 sprint)
- 期望排期:P1 或 P2,由主控定

主控评审时重点看:
- §六 验证方式是否具备"数字化的成功判据"(watch 数从 X 降到 Y)
- §五 Node 同步策略是否可执行(是否需要给 Node agent 单独派活)
- §八 部署考量的兼容性是否覆盖"业务方已有 rules.json"场景

---

**Plan 状态:** 待用户确认后进入阶段 1 起 spec
**作者:** 数据 Agent(Kiro)
**创建日期:** 2026-07-04
**依赖:** `monitor_lib_shared`(已在 main),`monitor_lib_parity_ci`(spec 已合,实施待)
