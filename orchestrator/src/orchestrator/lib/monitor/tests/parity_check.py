"""Parity 校验:Python 版 vs Node 版 monitor.js 在相同 fixture 下的输出等价。

用法:
    cd orchestrator
    PYTHONPATH=src python3 -m orchestrator.lib.monitor.tests.parity_check

要求:
    - node 可执行
    - 从 dashboard 分支能拿到 model-tag-monitor/src/monitor.js
      (或直接指向本地 /Users/lilixiaoran/工作/转转/model-tag-monitor)

对比范围:
    - pool 长度、模型列表(category, modelName)
    - watchList 长度、模型列表
    - 每个 watch 项的 flags(type/metric)集合
    - delta 数值 |diff| < 1e-9

不 diff 顺序细节和字段名 casing(Node 用 targetWeek,Python 存内部字段 target_week
但序列化后一致)。
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---- 路径 ----
FIXTURE = Path(__file__).parent / "fixtures" / "cache_sample.json"
NODE_MONITOR_JS_CANDIDATES = [
    Path("/Users/lilixiaoran/工作/转转/model-tag-monitor/src/monitor.js"),
]

# ---- Python 侧 ----

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))  # orchestrator/src

from orchestrator.lib.monitor.rules import apply_rules  # noqa: E402
from orchestrator.lib.monitor.schemas import FunnelRow, MonitorRules  # noqa: E402
from orchestrator.lib.monitor.wave import compute_wave  # noqa: E402


def _find_node_monitor() -> Path:
    for p in NODE_MONITOR_JS_CANDIDATES:
        if p.exists():
            return p
    raise FileNotFoundError(
        "找不到 Node 版 monitor.js。检查 "
        f"{NODE_MONITOR_JS_CANDIDATES}"
    )


def run_node(cache_path: Path, target_week: str) -> dict:
    """把 fixture 塞给 Node 版 monitor.js 跑一遍,返回 JSON 结果。"""
    monitor_js = _find_node_monitor()

    driver = f"""
const {{ monitor }} = require({json.dumps(str(monitor_js))});
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync({json.dumps(str(cache_path))}, 'utf-8'));
const result = monitor(cache, {{}}, {{}}, {{ week: {json.dumps(target_week)} }});
process.stdout.write(JSON.stringify(result));
"""
    proc = subprocess.run(
        ["node", "-e", driver],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node exited {proc.returncode}: {proc.stderr}")
    return json.loads(proc.stdout)


def run_python(cache_path: Path, target_week: str) -> dict:
    with cache_path.open("r", encoding="utf-8") as f:
        cache = json.load(f)
    rows = [FunnelRow(**r) for r in cache["rows"]]
    rules = MonitorRules()

    all_weeks = sorted(set(r.week for r in rows))
    if target_week not in all_weeks:
        raise ValueError(f"target_week {target_week} not in {all_weeks}")
    idx = all_weeks.index(target_week)
    prev_week = all_weeks[idx - 1] if idx > 0 else None

    waves, weeks_sorted = compute_wave(rows, target_week, prev_week, rules)
    result = apply_rules(waves, weeks_sorted, target_week, prev_week, rules)
    return result.model_dump(by_alias=True)


def diff_pool(node_pool: list, py_pool: list) -> list[str]:
    """返回 diff 消息列表(空 = 一致)。"""
    diffs = []
    n_ids = sorted((p["category"], p["modelName"]) for p in node_pool)
    p_ids = sorted((p["category"], p["modelName"]) for p in py_pool)
    if n_ids != p_ids:
        only_node = set(n_ids) - set(p_ids)
        only_py = set(p_ids) - set(n_ids)
        diffs.append(f"pool 成员不同 · only_node={only_node} · only_py={only_py}")
    return diffs


def diff_watch(node_watch: list, py_watch: list) -> list[str]:
    diffs = []
    n_ids = sorted((w["category"], w["modelName"]) for w in node_watch)
    p_ids = sorted((w["category"], w["modelName"]) for w in py_watch)
    if n_ids != p_ids:
        only_node = set(n_ids) - set(p_ids)
        only_py = set(p_ids) - set(n_ids)
        diffs.append(f"watchList 成员不同 · only_node={only_node} · only_py={only_py}")
        return diffs

    # 逐机型比 flags 与 delta
    py_by_id = {(w["category"], w["modelName"]): w for w in py_watch}
    for nw in node_watch:
        key = (nw["category"], nw["modelName"])
        pw = py_by_id[key]

        # flags 集合(不比顺序)
        n_flags = {
            (f["type"], f["metric"], f.get("direction"))
            for f in nw["flags"]
        }
        p_flags = {
            (f["type"], f["metric"], f.get("direction"))
            for f in pw["flags"]
        }
        if n_flags != p_flags:
            diffs.append(f"{key} flags 集合不同 · node={n_flags} · py={p_flags}")

        # delta 数值(逐指标)
        for k, nd in nw["delta"].items():
            pd = pw["delta"].get(k)
            if nd is None and pd is None:
                continue
            if nd is None or pd is None:
                diffs.append(f"{key} delta.{k} None 状态不一致 · node={nd} · py={pd}")
                continue
            if not math.isclose(nd, pd, abs_tol=1e-9):
                diffs.append(f"{key} delta.{k} 差 {abs(nd - pd)} · node={nd} · py={pd}")
    return diffs


def main():
    target_week = "2025-W27"

    print(f"=== Parity 校验(target_week={target_week}) ===")

    # 把 fixture 转成 Node 版 cache.json 结构
    # Node 版期望 { weeks: [...], rows: [...] } —— 我们的 fixture 已经是这个结构
    with FIXTURE.open("r", encoding="utf-8") as f:
        fixture_content = f.read()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        f.write(fixture_content)
        cache_tmp = Path(f.name)

    try:
        # 检查 node
        if not shutil.which("node"):
            print("❌ node 未安装")
            sys.exit(2)

        node_result = run_node(cache_tmp, target_week)
        py_result = run_python(cache_tmp, target_week)

        print(f"  Node pool={len(node_result['pool'])} watch={len(node_result['watchList'])}")
        print(f"  Py   pool={len(py_result['pool'])} watch={len(py_result['watchList'])}")

        all_diffs = []
        all_diffs += diff_pool(node_result["pool"], py_result["pool"])
        all_diffs += diff_watch(node_result["watchList"], py_result["watchList"])

        if not all_diffs:
            print("✅ 全部等价")
            sys.exit(0)
        print(f"❌ {len(all_diffs)} 处差异:")
        for d in all_diffs:
            print(f"  - {d}")
        sys.exit(1)
    finally:
        cache_tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
