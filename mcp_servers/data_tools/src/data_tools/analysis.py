"""分析原子：拆维度 / 算口径 / 套框架 / 调案例（MVP-1: 前两个真实，后两个 stub）。"""
from __future__ import annotations

import pandas as pd
from pathlib import Path


def parse_csv(file_path: str) -> dict:
    """读 CSV，返回 schema + 前 N 行预览 + records 摘要。

    返回结构：
    {
        "columns": [...],
        "dtypes": {...},
        "n_rows": int,
        "preview": [行 dict 列表 前 10 行],
        "records_file": file_path,    # 后续工具继续操作时引用
    }
    """
    p = Path(file_path)
    if not p.exists():
        raise FileNotFoundError(file_path)
    # 自动判断编码
    try:
        df = pd.read_csv(p, encoding="utf-8")
    except UnicodeDecodeError:
        df = pd.read_csv(p, encoding="gbk")
    return {
        "columns": df.columns.tolist(),
        "dtypes": {c: str(df[c].dtype) for c in df.columns},
        "n_rows": int(len(df)),
        "preview": df.head(10).to_dict(orient="records"),
        "records_file": str(p),
    }


def split_dimension(file_path: str, by: str, metric: str, agg: str = "sum") -> dict:
    """按维度拆解。返回每个维度值的聚合 + 占比。"""
    df = _read(file_path)
    if by not in df.columns:
        raise KeyError(f"维度 {by} 不在列中：{df.columns.tolist()}")
    if metric not in df.columns:
        raise KeyError(f"指标 {metric} 不在列中：{df.columns.tolist()}")
    grouped = df.groupby(by)[metric].agg(agg).sort_values(ascending=False)
    total = float(grouped.sum())
    return {
        "by": by,
        "metric": metric,
        "agg": agg,
        "total": total,
        "groups": [
            {"value": str(k), "value_metric": float(v), "pct": (float(v) / total * 100) if total else 0}
            for k, v in grouped.items()
        ],
    }


def calc_caliber(
    file_path: str,
    metric: str,
    period_col: str,
    current_period: str,
    compare_period: str,
    label: str = "环比",
) -> dict:
    """同比/环比口径计算（最朴素版）。"""
    df = _read(file_path)
    cur = df.loc[df[period_col].astype(str) == current_period, metric].sum()
    cmp_ = df.loc[df[period_col].astype(str) == compare_period, metric].sum()
    delta = float(cur) - float(cmp_)
    pct = (delta / cmp_ * 100) if cmp_ else None
    return {
        "metric": metric,
        "label": label,
        "current_period": current_period,
        "compare_period": compare_period,
        "current_value": float(cur),
        "compare_value": float(cmp_),
        "delta_abs": delta,
        "delta_pct": pct,
    }


def match_framework(question: str) -> dict:
    """匹配适用的分析框架。MVP-1 stub：返回最相关的 1-2 个原则编号。"""
    q = question.lower()
    matched = []
    if any(w in q for w in ["为什么", "归因", "异常", "诊断", "原因"]):
        matched.append({"id": "§4", "name": "异动诊断四问", "why": "用户问归因，强制走四问"})
        matched.append({"id": "§1", "name": "三层穿透", "why": "归因必查上游/市场/内部三层"})
    if any(w in q for w in ["优化", "提升", "建议", "怎么做"]):
        matched.append({"id": "§3", "name": "价值链瓶颈", "why": "给建议前必须先定位瓶颈"})
        matched.append({"id": "§5", "name": "动作闭环", "why": "建议必须带验证/基线/预期/成本/ROI"})
    if any(w in q for w in ["周报", "汇报", "数据"]):
        matched.append({"id": "§2", "name": "生命周期×阈值", "why": "汇报数据必须看绝对位置"})
    if not matched:
        matched.append({"id": "§6", "name": "自检清单", "why": "默认走自检清单"})
    return {"question": question, "frameworks": matched}


def get_case(question: str, similarity_threshold: float = 0.7) -> dict:
    """调历史案例。MVP-1 stub：返回空列表（MVP-2 接向量库）。"""
    return {
        "question": question,
        "matches": [],
        "note": "MVP-1 stub - 历史案例库待 MVP-2 接入向量检索",
    }


def _read(path: str) -> pd.DataFrame:
    try:
        return pd.read_csv(path, encoding="utf-8")
    except UnicodeDecodeError:
        return pd.read_csv(path, encoding="gbk")
