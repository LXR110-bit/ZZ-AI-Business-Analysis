# Spec · monitor_noise_reduction

> **状态**:设计定稿,实施待启动
> **优先级**:P1(monitor_lib_shared 已在 main,信噪比不修则 model_weekly_monitor 上线飞书群会被业务方吐槽)
> **归属**:`orchestrator/src/orchestrator/lib/monitor/`(Python)+ `model-tag-monitor/src/monitor.js`(Node,同 PR 同步)
> **作者**:数据 Agent
> **最后更新**:2026-07-04

---

## 一、目的

**治理"异常机型清单里大量出现量级过小的机型"这一信噪比问题**,让 `watchList` 只保留业务上真正值得关注的机型,不动前端展示层。

### 数据实锤

数据 Agent 用 `data/real_snapshot/monitor_snapshot`(10 品类 × 5 周 × 63k 行 raw)跑当前默认规则(`poolTopN=20, minEvaUv=15, waveThreshold=0.1`),得到:

**每品类 pool 里 evaUv 分布**(target_week=2026-W27):

```
品类              总机型  pool watch  pool_min  pool_p50  pool_max
------------------------------------------------------------------
主板             2398    20    0        5.0        6.0     11.5
便携/无线音箱      1283    20   20       15.0       32.5    122.5
内存条            1448    20   20       20.0       36.5    159.5
台球杆            1685    20   20       42.5       58.0    162.5
手表/腕表          2573    20    6        5.0       10.5     64.5
打印机/复印机       1416    20    2        4.5        6.5     26.5
数码相机           1355    20   14       11.5       21.0    103.5
显卡             6155    20   20       18.0       23.5     65.0
显示器            4800    20   20       21.0       27.0     57.5
盲盒收纳           1950    20    0        0.5        0.5      0.5
------------------------------------------------------------------
合计:             pool=200  watch=122
```

**watchList 里 evaUv 分桶**:

```
   <20  :  12  (10%)
 20-50  :  79  (65%)   ← 主力"噪音区"
50-100  :  24  (20%)
100-500 :   7  ( 6%)
 >=500  :   0  ( 0%)   ← 一个都没有
```

**结论**:当前 122 个异常机型里 **95% evaUv < 100**,严重信噪比失衡。

### 根因分层

1. **`poolTopN=20` 硬规定"每品类都取 top20"** —— 大品类 top20 都是量级充足的,小品类 top20 尾部会掉到 evaUv=0.5(盲盒收纳)
2. **`minEvaUv=15` 全局阈值太宽** —— 让小品类尾部机型顺利进入判定
3. **品类量级差异 400 倍**(盲盒收纳总 evaUv=12 vs 台球杆=4980)—— **单一全局阈值不可能一刀切合理**
4. **全局调 `minEvaUv` 会让部分品类"整个消失"**:`minEvaUv=100` 时全部 watch 只剩 7 个,`minEvaUv=200` 时 watch=0。太严了

### 服务对象

- `model_weekly_monitor` / `category_weekly_monitor` 上线飞书群时的业务方
- dashboard 现有环图/异常清单的运营用户
- 未来接 AI 归因的 spawn_agent(减少无效归因浪费 token)

---

## 二、能力清单

在 `MonitorRules` 里新增两个可选字段,把 `detect_flags` 的分母保护从"单一全局 `minEvaUv`"改为**三级 fallback**。

### ① 新字段 · `perCategoryMinEvaUv: Dict[str, float]`

分品类**绝对阈值**,业务方可精细调优。

- **key**:category_name(中文串,如 "手机" "台球杆"),不用 category_id
  - 理由:业务方直接看得懂,后台可视化编辑门槛低
  - 边界:某品类改名(如"电脑"→"计算机")时 key 匹配不上 → 降级到 `minEvaUvPct` 或全局 `minEvaUv`,不报错
- **默认值**:`{}`(空 dict,不启用此层)

### ② 新字段 · `minEvaUvPct: Optional[float]`

**品类占比过滤**:该机型 evaUv >= 品类当周总 evaUv × pct 才判定。

- **默认值**:`None`(不启用此层,保持当前行为兼容)
- **推荐启用值**:`0.02` ~ `0.03`(见 §六 实测)
- **优点**:自适应品类大小,业务方一个数搞定所有品类

### ③ 修改 · `detect_flags` 分母保护

从:
```python
if wave.cur.evaUv < rules.minEvaUv: return []
```
改为:
```python
effective = _effective_min_evauv(wave.category, cat_total_evauv, rules)
if wave.cur.evaUv < effective: return []
```

其中 `_effective_min_evauv(cat, cat_total, rules)` 实现三级 fallback:

```
优先级 1: rules.perCategoryMinEvaUv[cat]     若 cat 在 map 里
优先级 2: cat_total × rules.minEvaUvPct       若 minEvaUvPct is not None
优先级 3: rules.minEvaUv                       (全局兜底)
```

---

## 三、Rules Schema 扩展

### 完整 rules.json 示例(启用所有新字段)

```jsonc
{
  "poolTopN": 20,
  "waveThreshold": 0.1,
  "trendWeeks": 3,
  "minEvaUv": 15,                       // 全局兜底,不变

  // === 新增 ===
  "minEvaUvPct": 0.02,                  // 品类占比 2%
  "perCategoryMinEvaUv": {              // 主要品类白名单
    "台球杆": 200,
    "显卡": 100,
    "显示器": 100
  },

  "rates": [
    {"key": "evaRate", "name": "估价完成率"},
    {"key": "orderRate", "name": "估价下单率"},
    {"key": "shipRate", "name": "估价发货率"},
    {"key": "dealRate", "name": "估价成交率"},
    {"key": "returnRate", "name": "质检退回率"}
  ]
}
```

### 向后兼容契约

**新字段全部有 falsy 默认**:
- `perCategoryMinEvaUv={}` → 优先级 1 全部跳过
- `minEvaUvPct=None` → 优先级 2 全部跳过
- 结果等同于"只跑优先级 3 = 现有全局 minEvaUv 行为"

**结论**:业务方**不改任何配置**时,升级后行为跟升级前**完全一致**。这也是零破坏性升级的关键。

---

## 四、算法改动点(引用具体代码位置)

### 4.1 `orchestrator/src/orchestrator/lib/monitor/schemas.py`

`MonitorRules` 类新增两个 pydantic 字段:

```python
class MonitorRules(BaseModel):
    # ...(现有字段不变)
    minEvaUv: float = Field(15.0, ge=0.0, description="全局兜底:evaUv 低于此值不参与判定")

    # === 新增 ===
    perCategoryMinEvaUv: Dict[str, float] = Field(
        default_factory=dict,
        description="分品类绝对阈值,key=category_name(中文串);优先级最高。缺失/品类改名 → 降级到 minEvaUvPct → minEvaUv 兜底",
    )
    minEvaUvPct: Optional[float] = Field(
        None, ge=0.0, le=1.0,
        description="品类占比过滤(0.02 = 该机型 evaUv 至少要占品类总 evaUv 的 2%);None=不启用,走 minEvaUv 兜底",
    )
```

### 4.2 `orchestrator/src/orchestrator/lib/monitor/rules.py`

**新增 helper**(便于单测,不动 `detect_flags` 主体的 Node 等价性):

```python
def _effective_min_evauv(
    category: str,
    cat_total_evauv: float,
    rules: MonitorRules,
) -> float:
    """三级 fallback。返回该品类下当前生效的最小 evaUv 阈值。"""
    # 优先级 1:分品类白名单
    if category in rules.perCategoryMinEvaUv:
        return rules.perCategoryMinEvaUv[category]
    # 优先级 2:品类占比
    if rules.minEvaUvPct is not None:
        return cat_total_evauv * rules.minEvaUvPct
    # 优先级 3:全局兜底
    return rules.minEvaUv
```

**修改** `detect_flags`(§ line 92 附近)从:

```python
if (wave.cur.evaUv or 0) < rules.minEvaUv:
    return flags
```

改为:

```python
effective = _effective_min_evauv(wave.category, cat_total_evauv, rules)
if (wave.cur.evaUv or 0) < effective:
    return flags
```

**修改** `apply_rules` 入参签名(§ line 131),为每个品类算总 evaUv 传给 `detect_flags`:

```python
def apply_rules(wave_results, all_weeks, target_week, prev_week, rules):
    # 先按品类聚合 target_week 的总 evaUv(供 minEvaUvPct 使用)
    cat_totals: Dict[str, float] = {}
    for wr in wave_results:
        if wr.cur and wr.cur.week == target_week:
            cat_totals[wr.category] = cat_totals.get(wr.category, 0.0) + (wr.cur.evaUv or 0)

    pool = build_pool(wave_results, rules.poolTopN)
    watch_list = []
    for wr in pool:
        cat_total = cat_totals.get(wr.category, 0.0)
        flags = detect_flags(wr, rules, cat_total)  # 加个参数
        if flags:
            watch_list.append(WaveResultWithFlags(**wr.model_dump(), flags=flags))
    # ...
```

**修改** `detect_flags` 入参签名:

```python
def detect_flags(wave, rules, cat_total_evauv) -> List[Flag]:
    ...
```

### 4.3 category_name 常量文件(新建)

`orchestrator/src/orchestrator/lib/monitor/categories.py`(新建):

```python
"""品类名常量。

orchestrator/lib/monitor/ 独立维护,不跨 skill 依赖。
业务方如果在飞书表格里改品类名,需要在此文件同步维护(或做 migration 脚本)。
"""

# 已知业务品类白名单(用于配置校验和 IDE 提示,不做 runtime 强制)
KNOWN_CATEGORY_NAMES = frozenset({
    "手机", "笔记本电脑", "台式主机", "iPad",  # 主品类(未来接入)
    "台球杆", "显卡", "显示器", "内存条", "主板",  # 当前 real_snapshot 覆盖
    "便携/无线音箱", "手表/腕表", "打印机/复印机", "数码相机", "盲盒收纳",
    # ...(需要业务方 review 定稿)
})
```

**决策理由**:
- **独立维护**,不引用 `skills/workflows/机型周数据/constants.py`(避免跨 skill 依赖,orchestrator 保持自洽)
- **frozenset 不做 runtime 校验**,仅用于配置文件校验工具、IDE 提示;`perCategoryMinEvaUv` 里配置陌生品类名不报错,只是不生效(降级到下一级)

---

## 五、Node 版同步策略(强制同 PR)

### 为什么必须同 PR

**parity_ci(PR #18)会挡** —— 若只改 Python 版,Python 跟 Node 的 pool/watch 结果分叉,parity_ci 报错,PR 无法合入 main。

### Node 侧改动清单(`model-tag-monitor/src/monitor.js`)

**改动 1**:`R` 对象(rules 默认值)新增两字段:

```js
const R = {
  ...(现有),
  minEvaUvPct: null,
  perCategoryMinEvaUv: {},
};
```

**改动 2**:新增 helper:

```js
function effectiveMinEvaUv(category, catTotalEvaUv, R) {
  if (R.perCategoryMinEvaUv && Object.prototype.hasOwnProperty.call(R.perCategoryMinEvaUv, category)) {
    return R.perCategoryMinEvaUv[category];
  }
  if (R.minEvaUvPct !== null && R.minEvaUvPct !== undefined) {
    return catTotalEvaUv * R.minEvaUvPct;
  }
  return R.minEvaUv;
}
```

**改动 3**:在 `monitor()` 函数里,`if (p.cur.evaUv >= R.minEvaUv)` 判定前算 catTotals,替换判定为 `if (p.cur.evaUv >= effectiveMinEvaUv(p.category, catTotals[p.category] || 0, R))`

### 一次 PR 两侧同改

- 数据 Agent(本 spec 作者)负责 Python + Node 两侧代码
- **不派独立 Node agent**(跨 session 沟通成本高,数据 agent 最懂设计意图)
- CI 通过顺序:`monitor-lib-tests` 绿 + `monitor-lib-parity` 绿(若已上线;未上线则 PR 里手跑 `verify_equivalence_real.py`)

---

## 六、验证方式

### 6.1 单测(新增 3 个 case,pytest 从 35 → 38 全绿)

`orchestrator/src/orchestrator/lib/monitor/tests/test_rules.py`:

```python
def test_effective_min_evauv_per_category_wins():
    """优先级 1:白名单命中"""
    rules = MonitorRules(
        minEvaUv=15,
        minEvaUvPct=0.02,
        perCategoryMinEvaUv={"手机": 500},
    )
    assert _effective_min_evauv("手机", 10000, rules) == 500
    # 白名单没命中的品类降级
    assert _effective_min_evauv("台球杆", 5000, rules) == 100  # 5000 * 0.02

def test_effective_min_evauv_pct_fallback():
    """优先级 2:占比生效"""
    rules = MonitorRules(minEvaUv=15, minEvaUvPct=0.03, perCategoryMinEvaUv={})
    assert _effective_min_evauv("台球杆", 5000, rules) == 150  # 5000 * 0.03

def test_effective_min_evauv_global_fallback():
    """优先级 3:全局兜底"""
    rules = MonitorRules(minEvaUv=15, minEvaUvPct=None, perCategoryMinEvaUv={})
    assert _effective_min_evauv("台球杆", 5000, rules) == 15
```

### 6.2 真实数据实测表(数据 agent 已跑,写进 spec 供业务方参考)

**场景 A · 完全零配置(baseline)**:

```
watch = 122  (现状,不变)
```

**场景 B · 只开 `minEvaUvPct`(白名单空)**:

| pct    | watch | 品类分布(top 5)                                              |
|--------|-------|-------------------------------------------------------------|
| 1.0%   | 94    | 便携:18, 内存条:14, 手表:14, 台球杆:12, 打印机:11             |
| **2.0%**   | **39** | **便携:10, 内存条:7, 手表:6, 数码相机:6, 台球杆:4**             |
| **3.0%**   | **22** | **便携:5, 手表:5, 盲盒:4, 数码相机:3, 内存条:2**               |
| 5.0%   | 6     | 手表:3, 便携:1, 内存条:1, 数码相机:1                           |
| 10.0%  | 0     | -                                                            |

**主控推荐默认值**:`minEvaUvPct = 0.02 或 0.03`(watch 从 122 降到 22-39,减 68%-82%,分布均衡不偏科)

**场景 C · 白名单 + pct fallback**(实际生产推荐姿态):

```
perCategoryMinEvaUv = {"台球杆": 200, "显卡": 100, "显示器": 100}
minEvaUvPct = 0.02, minEvaUv = 15
→ watch = 35 (分布:便携:10, 内存条:7, 手表:6, 数码相机:6, 盲盒:4, 打印机:2)
```

**场景 D · 全部白名单严阈值**(演示白名单主导):

```
perCategoryMinEvaUv = {便携:100, 内存条:100, 台球杆:200, 数码相机:100, 显卡:100, 显示器:100}
→ watch = 11 (盲盒收纳完全消失,达到"过滤长尾品类"目标)
```

### 6.3 Node 等价性对拍

同 PR 两侧同改后,跑:

```bash
python scripts/verify_equivalence_real.py --with-new-rules-config path/to/config.json
```

预期 `|diff| < 1e-9`(与 W27 一次对拍精度对齐)。

### 6.4 成功判据(spec 阶段 2 完成的判定标准)

- [ ] 38 单测全绿
- [ ] 用 `minEvaUvPct=0.03` 跑 real_snapshot,watch 从 122 降到 22 附近(±5 容差)
- [ ] Node parity 对拍 `|diff| < 1e-9`
- [ ] 业务方看一眼 `场景 C` 的 rules.json 例子,认可

---

## 七、契约影响

`WaveReport.rules` schema 里会新增两个可选字段,**前端零 breaking change**:
- `WaveReport.rules.perCategoryMinEvaUv`
- `WaveReport.rules.minEvaUvPct`

`data_to_frontend_contract.md` §五 更新一段说明,告知前端"这两个新字段目前只由后端消费,前端可选择在'规则说明'面板展示,不强求"。

**未来演进**(不属本 spec 范围):
- 前端 rules 说明面板显示"手机品类·当前有效 evaUv 阈值 500"(spec 落地 + 主控确认稳定 1 周后再启动前端 agent)

---

## 八、部署考量

### 8.1 现有 rules.json 兼容性

生产环境目前的 `data/rules.json` 只有旧字段。升级后:
- Pydantic 默认值填充:`perCategoryMinEvaUv={}`, `minEvaUvPct=None`
- `_effective_min_evauv` 走优先级 3 兜底 → 等同于当前 `minEvaUv=15` 行为
- **无需迁移脚本,无需数据变更**

### 8.2 分步启用建议

不建议 spec 落地后立刻在生产 rules.json 里配全白名单。建议节奏:

**Week 1(spec 阶段 2 上线)**:配置不动,验证升级后行为等同于升级前(watch 仍是 122)

**Week 2**:先开 `minEvaUvPct=0.03`(watch 降到 22,给业务方一个"平缓改善"的感受)

**Week 3+**:业务方根据实际使用手感,针对特定品类微调 `perCategoryMinEvaUv`

### 8.3 后台可视化编辑接入(未来)

规则管理 agent 那条线(见 `master_agent_bootstrap.md` §四 P0.2)未来做后台调阈值时,新字段需要暴露到 UI。表单结构建议:

- `minEvaUvPct`:百分比 slider(0-10%,默认 None/关闭)
- `perCategoryMinEvaUv`:表格,每行 `品类名 + 阈值`,支持增删

---

## 九、交付边界(明确不做)

- ❌ **不做前端 filter UI** —— 会导致"这周异常 X 个"前后端对不上;信噪比在数据层根治
- ❌ **不做 S/A/B 机型分档** —— 那是长期方案(P3),需要业务方 offline 打标,超出本 spec 范围
- ❌ **不改契约字段主结构** —— `WaveReport` 只加两个可选 rules 字段,前端零改动
- ❌ **不动 `poolTopN`** —— 这是 pool 大小,跟"过滤"是两回事;若未来要"分品类不同 topN",另开 spec
- ❌ **不改 `waveThreshold` 或 `trendWeeks`** —— 那是波动/趋势判定的核心业务参数,业务方决定,不在本 spec 范围

---

## 十、实施动作清单(阶段 2,主控排期后启动)

- [ ] Step 1:数据 agent 起分支 `feature/monitor-noise-reduction`,从最新 main 起
- [ ] Step 2:改 `schemas.py::MonitorRules`,加两个字段
- [ ] Step 3:新建 `categories.py`,写 KNOWN_CATEGORY_NAMES(等业务方 review 后 finalize,不阻塞代码)
- [ ] Step 4:改 `rules.py`,加 `_effective_min_evauv` helper + 修改 `detect_flags` + 修改 `apply_rules`
- [ ] Step 5:单测 `test_rules.py` 加 3 个 case
- [ ] Step 6:跑 `pytest src/orchestrator/lib/monitor/tests/ -v`,预期 38 全绿
- [ ] Step 7:同 PR 改 `model-tag-monitor/src/monitor.js`(§五),`npm test` 若有 test 跑一次
- [ ] Step 8:跑 `verify_equivalence_real.py`,`|diff| < 1e-9`
- [ ] Step 9:更新 `data_to_frontend_contract.md` §五 加两字段说明
- [ ] Step 10:更新 `PROJECT_STATUS.md`(记这次交付)
- [ ] Step 11:提 PR,`monitor-lib-tests` + `monitor-lib-parity` 双绿
- [ ] Step 12:主控 review + merge

---

## 十一、依赖 & 关联

- **依赖(必须先在 main)**:`monitor_lib_shared`(PR #19,已合)
- **协同**:`monitor_lib_parity_ci`(PR #18 spec 已合,实施待)—— 若 parity_ci 已实施,本 spec 落地时是"两条 CI 都要绿";若 parity_ci 未实施,本 spec 落地时手跑 `verify_equivalence_real.py`
- **未阻塞**:`model_weekly_monitor` / `category_weekly_monitor` 的实施可以并行(本 spec 不改契约主结构)
- **不阻塞**:前端 rules 说明面板(未来 P2,稳定 1 周后启动)

---

## 十二、成功后的世界

**Before**(当前):
- watch=122,业务方在飞书群里看到"盲盒收纳品类某机型 evaUv=0.5,orderRate 波动 500%"—— 无意义,徒增焦虑
- AI 归因 spawn_agent 对小机型做归因浪费 token

**After**(spec 阶段 2 落地 + 配 `minEvaUvPct=0.03`):
- watch=22,每条都是"这个真的值得关注"级别
- 飞书周报"本周 22 个异常机型"业务方能一条条看完
- AI 归因效率翻 5 倍

---

**Spec 状态**:待主控 review
**Handoff**:数据 agent 完成 → `send_message` 主控 → 主控 review → merge(plan + spec 同 PR)→ 主控排期阶段 2
