#!/usr/bin/env python3
"""
Python vs Node 等价性验证 — 用真实生产数据(显卡品类,22034 行)

数据源:
  - data/real_snapshot/gpu_raw.json      —— 从 47.84.94.234:8848/api/data?category=显卡
  - data/real_snapshot/gpu_monitor_node.json —— 从 /api/monitor (全品类,过滤出显卡)
  - data/real_snapshot/rules.json        —— 从 /api/rules

验证维度:
  1. pool 成员集合一致(category||modelName)
  2. watchList 成员集合一致
  3. 每项的 delta 值 |diff| < 1e-9
  4. flags 集合完全一致(type+metric+direction)
  5. rules shape 一致(已在前面手动核对)

输出:
  diff 报告 markdown -> data/real_snapshot/EQUIVALENCE_REPORT.md
  exit 0: 完全一致 | 1: 有差异
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'orchestrator' / 'src'))

from orchestrator.lib.monitor.schemas import FunnelRow, MonitorRules  # noqa: E402
from orchestrator.lib.monitor.wave import compute_wave  # noqa: E402
from orchestrator.lib.monitor.rules import apply_rules  # noqa: E402


SNAPSHOT = ROOT / 'data' / 'real_snapshot'
REPORT = SNAPSHOT / 'EQUIVALENCE_REPORT.md'
import os
CATEGORY = os.environ.get('CATEGORY', '显卡')


def load_inputs():
    raw = json.loads((SNAPSHOT / 'gpu_raw.json').read_text())
    node = json.loads((SNAPSHOT / 'gpu_monitor_node.json').read_text())
    rules = json.loads((SNAPSHOT / 'rules.json').read_text())

    rows = raw['rows']
    # Node monitor 是全品类,过滤出 GPU
    node_pool = [x for x in node['pool'] if x['category'] == CATEGORY]
    node_watch = [x for x in node['watchList'] if x['category'] == CATEGORY]

    return rows, node_pool, node_watch, rules, node['weeks'], node['targetWeek']


def run_python(rows_dict, rules_dict, weeks, target_week):
    """跑 Python 版,返回 (pool_list, watch_list) —— 只含显卡."""
    # 转 FunnelRow
    rows = []
    for r in rows_dict:
        # returnRate 是 None 也保留(下游能处理)
        # 只保留 schemas 支持的字段
        rows.append(FunnelRow(
            week=r['week'],
            startDate=r.get('startDate'),
            endDate=r.get('endDate'),
            category=r['category'],
            modelId=r.get('modelId'),
            modelName=r['modelName'],
            jkuv=r.get('jkuv'),
            evaUv=r.get('evaUv'),
            orderUv=r.get('orderUv'),
            orderCnt=r.get('orderCnt'),
            shipCnt=r.get('shipCnt'),
            signCnt=r.get('signCnt'),
            qcCnt=r.get('qcCnt'),
            dealCnt=r.get('dealCnt'),
            returnCnt=r.get('returnCnt'),
            gmv=r.get('gmv'),
            evaCnt=r.get('evaCnt'),
            avgPrice=r.get('avgPrice'),
            daysReceived=r.get('daysReceived'),
            evaRate=r.get('evaRate'),
            orderRate=r.get('orderRate'),
            shipRate=r.get('shipRate'),
            dealRate=r.get('dealRate'),
            returnRate=r.get('returnRate'),
        ))

    monitor_rules = MonitorRules(**rules_dict)
    # target_week / prev_week: 显卡最后两周
    # Node 版 monitor.js 里 prev_week 是 weeks 里 target_week 的上一个
    prev_week = None
    if target_week in weeks:
        idx = weeks.index(target_week)
        if idx > 0:
            prev_week = weeks[idx - 1]

    waves, all_weeks = compute_wave(rows, target_week, prev_week, monitor_rules)
    result = apply_rules(waves, all_weeks, target_week, prev_week, monitor_rules)

    return result.pool, result.watch_list


def compare(node_pool, py_pool, node_watch, py_watch):
    """核心 diff."""
    report_lines = []

    def key(item):
        # dict 和 pydantic 都用 dict-like 访问
        if hasattr(item, 'category'):
            return f'{item.category}||{item.modelName}'
        return f'{item["category"]}||{item["modelName"]}'

    node_pool_keys = {key(x) for x in node_pool}
    py_pool_keys = {key(x) for x in py_pool}
    node_watch_keys = {key(x) for x in node_watch}
    py_watch_keys = {key(x) for x in py_watch}

    diffs = {}

    # 1. pool 成员 —— 允许 evaUv tie 边界互换(契约不保证 tie 稳定性)
    # 找每个 pool 里最小的 evaUv 值(边界)
    def min_evauv(pool):
        vals = []
        for x in pool:
            cur = x['cur'] if isinstance(x, dict) else (
                x.cur.model_dump() if hasattr(x.cur, 'model_dump') else x.cur
            )
            vals.append(cur.get('evaUv', 0) if isinstance(cur, dict) else cur.evaUv)
        return min(vals) if vals else None

    node_boundary = min_evauv(node_pool)
    py_boundary = min_evauv(py_pool)

    only_node_raw = node_pool_keys - py_pool_keys
    only_py_raw = py_pool_keys - node_pool_keys

    # 允许对方向 tie:只要 node_only 里的 evaUv == py_only 里的 evaUv == boundary
    def boundary_ev(pool, keys_wanted):
        result = {}
        for x in pool:
            k = key(x)
            if k not in keys_wanted:
                continue
            cur = x['cur'] if isinstance(x, dict) else (
                x.cur.model_dump() if hasattr(x.cur, 'model_dump') else x.cur
            )
            ev = cur.get('evaUv', 0) if isinstance(cur, dict) else cur.evaUv
            result[k] = ev
        return result

    node_only_ev = boundary_ev(node_pool, only_node_raw)
    py_only_ev = boundary_ev(py_pool, only_py_raw)

    # 契约:tie 边界上互换视为等价
    real_only_node = sorted(k for k, ev in node_only_ev.items() if ev != node_boundary)
    real_only_py = sorted(k for k, ev in py_only_ev.items() if ev != py_boundary)
    tie_swapped_node = sorted(k for k, ev in node_only_ev.items() if ev == node_boundary)
    tie_swapped_py = sorted(k for k, ev in py_only_ev.items() if ev == py_boundary)

    diffs['pool_only_node'] = real_only_node  # 真差异
    diffs['pool_only_py'] = real_only_py
    diffs['pool_tie_swapped'] = {
        'node_side': tie_swapped_node,
        'py_side': tie_swapped_py,
        'boundary_evaUv': node_boundary,
    } if (tie_swapped_node or tie_swapped_py) else None

    # 2. watchList 成员
    diffs['watch_only_node'] = sorted(node_watch_keys - py_watch_keys)
    diffs['watch_only_py'] = sorted(py_watch_keys - node_watch_keys)

    # 3. 每个共同 pool 项的 delta 值
    node_by_key = {key(x): x for x in node_pool}
    py_by_key = {key(x): x for x in py_pool}
    common = node_pool_keys & py_pool_keys

    delta_diffs = []
    for k in sorted(common):
        n = node_by_key[k].get('delta')
        p_item = py_by_key[k]
        p = p_item.delta if hasattr(p_item, 'delta') else p_item.get('delta')
        # 归一化:两边都可能是 None(prev 缺失),或对象/字典(部分/全 None)。
        n_dict = n if isinstance(n, dict) else {}
        if p is None:
            p_dict = {}
        elif hasattr(p, 'model_dump'):
            p_dict = p.model_dump()
        else:
            p_dict = dict(p)
        # Node None == Python 全 None dict:两侧统一空
        if n is None and all(p_dict.get(r) is None for r in ['evaRate','orderRate','shipRate','dealRate','returnRate']):
            continue
        if p is None and all(n_dict.get(r) is None for r in ['evaRate','orderRate','shipRate','dealRate','returnRate']):
            continue
        for rate in ['evaRate', 'orderRate', 'shipRate', 'dealRate', 'returnRate']:
            nv = n_dict.get(rate)
            pv = p_dict.get(rate)
            if nv is None and pv is None:
                continue
            if nv is None or pv is None:
                delta_diffs.append((k, rate, nv, pv, 'null-mismatch'))
                continue
            d = abs(nv - pv)
            if d >= 1e-9:
                delta_diffs.append((k, rate, nv, pv, f'|diff|={d:.2e}'))
    diffs['delta_mismatches'] = delta_diffs

    # 4. flags 对拍(仅在 watchList 共同项上)
    node_wby = {key(x): x for x in node_watch}
    py_wby = {key(x): x for x in py_watch}
    common_watch = node_watch_keys & py_watch_keys

    flag_diffs = []
    for k in sorted(common_watch):
        n_flags = node_wby[k].get('flags', [])
        p_item = py_wby[k]
        p_flags_raw = p_item.flags if hasattr(p_item, 'flags') else p_item.get('flags', [])
        p_flags = [f.model_dump() if hasattr(f, 'model_dump') else dict(f) for f in p_flags_raw]

        # 归一化成可比 tuple:(type, metric, direction_or_none)
        def sig(f):
            return (f.get('type'), f.get('metric'), f.get('direction'))
        n_sigs = sorted(sig(f) for f in n_flags)
        p_sigs = sorted(sig(f) for f in p_flags)
        if n_sigs != p_sigs:
            flag_diffs.append((k, n_sigs, p_sigs))
    diffs['flag_mismatches'] = flag_diffs

    return diffs


def format_report(diffs, node_pool, py_pool, node_watch, py_watch):
    lines = []
    lines.append(f'# Python vs Node 等价性验证 — 真实数据({CATEGORY})')
    lines.append('')
    lines.append('数据源:47.84.94.234:8848 生产 API,同步日期 2026-07-04 04:43 UTC')
    lines.append(f'品类:{CATEGORY},pool 大小 Node={len(node_pool)} / Python={len(py_pool)}')
    lines.append('')
    lines.append('## 结果汇总')
    lines.append('')
    lines.append(f'| 维度 | Node | Python | Diff |')
    lines.append(f'|---|---|---|---|')
    lines.append(f'| pool 成员数 | {len(node_pool)} | {len(py_pool)} | '
                 f'{len(diffs["pool_only_node"]) + len(diffs["pool_only_py"])} |')
    lines.append(f'| watchList 成员数 | {len(node_watch)} | {len(py_watch)} | '
                 f'{len(diffs["watch_only_node"]) + len(diffs["watch_only_py"])} |')
    lines.append(f'| delta 数值 mismatch | — | — | {len(diffs["delta_mismatches"])} |')
    lines.append(f'| flags mismatch | — | — | {len(diffs["flag_mismatches"])} |')
    lines.append('')

    total_diff = (
        len(diffs['pool_only_node']) + len(diffs['pool_only_py']) +
        len(diffs['watch_only_node']) + len(diffs['watch_only_py']) +
        len(diffs['delta_mismatches']) + len(diffs['flag_mismatches'])
    )
    tie_note = diffs.get('pool_tie_swapped')

    if total_diff == 0:
        lines.append('## ✅ 等价性通过')
        lines.append('')
        lines.append(f'品类 {CATEGORY}: Python 版与 Node 版产出等价结果:')
        lines.append('- pool 大小一致 / 非 tie 成员一致')
        lines.append('- watchList 成员集合一致')
        lines.append('- 每项 delta 数值 |diff| < 1e-9')
        lines.append('- flags(type/metric/direction)集合一致')
        if tie_note:
            lines.append('')
            lines.append(f'契约允许的 tie 边界互换(evaUv={tie_note["boundary_evaUv"]}):')
            lines.append(f'  - Node 侧独有: {tie_note["node_side"]}')
            lines.append(f'  - Python 侧独有: {tie_note["py_side"]}')
    else:
        lines.append('## ❌ 有差异')
        lines.append('')
        for name, val in diffs.items():
            if val:
                lines.append(f'### {name} ({len(val)})')
                for x in val[:10]:
                    lines.append(f'  - {x}')
                if len(val) > 10:
                    lines.append(f'  - ... 还有 {len(val) - 10} 个')
                lines.append('')

    return '\n'.join(lines), total_diff


def main():
    print('=== 加载输入 ===')
    rows, node_pool, node_watch, rules, weeks, target_week = load_inputs()
    print(f'  raw rows: {len(rows)}')
    print(f'  node pool (GPU): {len(node_pool)}')
    print(f'  node watch (GPU): {len(node_watch)}')
    print(f'  rules: {rules}')
    print(f'  weeks: {weeks}')
    print(f'  target_week: {target_week}')
    print()

    print('=== 跑 Python 版 ===')
    py_pool, py_watch = run_python(rows, rules, weeks, target_week)
    print(f'  py pool: {len(py_pool)}')
    print(f'  py watch: {len(py_watch)}')
    print()

    print('=== 对拍 ===')
    diffs = compare(node_pool, py_pool, node_watch, py_watch)

    print('=== 生成报告 ===')
    report, total_diff = format_report(diffs, node_pool, py_pool, node_watch, py_watch)
    REPORT.write_text(report)
    print(f'  报告写到: {REPORT}')
    print(f'  总 diff 数: {total_diff}')

    if total_diff == 0:
        print()
        print('✅ 完全一致')
        return 0
    else:
        print()
        print('❌ 有差异,详见报告')
        # 简要打印
        for k, v in diffs.items():
            if v:
                print(f'  {k}: {len(v)}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
