"""pipeline v3: 按月拆 sheets, 分批 upsert, 6 月并发.

Flow:
  1. IMAP 近 lookback_days 天 zip → 本地缓存
  2. 解 zip → 5 xlsx 路由到 5 tab 大 dataframe
  3. 按 stat_date 归月 → {month: {tab: df_month}}
  4. 每月独立 groupby(周+机型+dims) sum + 已收到天数
  5. 并发: 每 month 一个 worker,月内 5 tab 串行,
     每 tab: upsert 汇总表 + upsert 日均表 (= 汇总/天数)

关键约束 (飞书 API):
  - csv-put 单次 > 1000 行易 14s timeout → 分批 1000 + 3 次 retry
  - dim-insert 单次 > 5000 行超时 → 分批 5000
  - 同一 sheets 内并发写有锁风险 → 月粒度并发,月内串行

设计守则 (2026-07-04 血泪教训, 请勿再违反):
  1. 清除 W 内旧数据用 `sheets_dim_delete` (整段删), 不用 `sheets_cells_clear` 逐行清.
     cells-clear 每批 10 行, 清 1 万行 = 1000 次 API × 0.5s = 8 分钟, 且极易 14s timeout.
     dim-delete 一次可删 5000 行, 差 500 倍效率.
  2. 每次 upsert 结尾必须调用 `_shrink_trailing_empty` (line 581).
     若 pipeline 崩在 _ensure_capacity 之后, 会遗留几万空行. 不 shrink → tail-fast 扫这几万空行
     → 下次 pipeline 慢 7-8 分钟找不到 boundary. 曾把 shrink 改成 `shrunk = 0` (禁用),
     结果就是 6725f1 从 rc=133925 膨胀到 178645 永不回收.
  3. 所有可能 timeout 的 dim-delete / dim-insert 循环都要用 rc-diff (workbook-info) 判断真实结果,
     忽略 transient LarkError. 服务端删除通常仍生效, 只是客户端 14s 提前放弃.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "mcp_servers" / "data_tools" / "src"))
from data_tools.email_reader import download_attachment, list_emails  # noqa: E402

from .local_imports import write_local_imports
from .mail_sources import missing_required_sources, required_sources

from .constants import (
    COMMON_DIMS,
    DAILY_AVG_TOKENS,
    EMAIL_SUBJECT,
    INTERMEDIATE_TABS,
    SUMMARY_TO_DAILY_AVG_SID,
    SUMMARY_TOKENS,
    XLSX_TO_INTERMEDIATE_HEADER,
    daily_avg_token_for,
    month_key,
    summary_token_for,
)
from .lark_helper import (
    LarkError,
    col_letter,
    sheets_cells_clear,
    sheets_csv_get,
    sheets_csv_put,
    sheets_dim_delete,
    sheets_dim_insert,
    sheets_workbook_info,
)

CACHE_DIR = Path("/tmp/机型周数据_zip_cache")
DEFAULT_LOOKBACK_DAYS = 14
CSV_PUT_BATCH = 300
DIM_INSERT_BATCH = 5000
CSV_PUT_RETRY = 5
CSV_PUT_RETRY_BACKOFF = 1  # attempt1 fail -> 1s backoff -> attempt2
CSV_PUT_CONSECUTIVE_TOLERATED_ABORT = int(os.environ.get("CSV_PUT_CONSECUTIVE_TOLERATED_ABORT", "3"))
SHRINK_BUFFER = 500  # 保留在末尾的空行 buffer
DIM_DELETE_BATCH = 5000
CELLS_CLEAR_BATCH = 10
CSV_GET_ROW_BATCH = 500
MAX_SCAN_ROW = 200000
MONTH_CONCURRENCY = 4
UPSERT_TAB_MAX_SECONDS = int(os.environ.get("UPSERT_TAB_MAX_SECONDS", "600"))
UPSERT_TAB_MAX_DELETE_BATCHES = int(os.environ.get("UPSERT_TAB_MAX_DELETE_BATCHES", "30"))


class UpsertBudget:
    """Per-tab guardrail: fail one oversized tab instead of blocking the whole run."""

    def __init__(self, label: str):
        self.label = label
        self.started = time.monotonic()
        self.delete_batches = 0

    def check(self, phase: str) -> None:
        elapsed = time.monotonic() - self.started
        if elapsed > UPSERT_TAB_MAX_SECONDS:
            raise LarkError(
                f"{self.label} timeout after {elapsed:.0f}s at {phase} "
                f"(limit={UPSERT_TAB_MAX_SECONDS}s)"
            )

    def count_delete_batch(self, phase: str) -> None:
        self.delete_batches += 1
        if self.delete_batches > UPSERT_TAB_MAX_DELETE_BATCHES:
            raise LarkError(
                f"{self.label} delete batch budget exceeded at {phase}: "
                f"{self.delete_batches}>{UPSERT_TAB_MAX_DELETE_BATCHES}"
            )


# ============================================================
# IMAP 缓存
# ============================================================
def fetch_recent_zips(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> list[Path]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    since = (date.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    emails = list_emails(subject_contains=EMAIL_SUBJECT, since=since, max_results=50)
    matched = [e for e in emails if EMAIL_SUBJECT in e.subject and e.attachments]
    zips: list[Path] = []
    for e in matched:
        m = re.search(r"(\d{1,2}) (\w+) (\d{4})", e.date)
        if not m:
            continue
        try:
            dt = datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%d %b %Y")
        except ValueError:
            continue
        day_str = dt.strftime("%Y-%m-%d")
        key = CACHE_DIR / f"{day_str}.zip"
        if key.exists():
            zips.append(key)
            continue
        zip_name = next((a for a in e.attachments if a.lower().endswith(".zip")), None)
        if not zip_name:
            continue
        tmp = tempfile.mkdtemp(prefix="ai_xiaowan_")
        path_str = download_attachment(e.uid, zip_name, tmp)
        shutil.move(path_str, key)
        shutil.rmtree(tmp, ignore_errors=True)
        zips.append(key)
    return sorted(set(zips))


# ============================================================
# xlsx 路由 + 规范化
# ============================================================
def _route_by_cols(cols: list[str]) -> str:
    lower = [c.lower() for c in cols]
    joined = " ".join(cols)
    has_jikuang = "机况uv" in lower
    has_luxing = "履约方式" in joined
    has_estim = "核心属性（估价）" in cols or "成色等级（估价）" in cols
    has_zhijian = "核心属性（质检）" in cols or "成色等级（质检）" in cols
    if has_zhijian: return "B0ZJKk"
    if has_estim and has_luxing: return "VsIzPj"
    if has_estim: return "7rBBpo"
    if has_luxing: return "053Pci"
    if has_jikuang: return "6725f1"
    raise ValueError(f"cannot route xlsx cols: {cols[:8]}")


def _normalize_xlsx_df(df: pd.DataFrame, sheet_id: str) -> pd.DataFrame:
    rename = {}
    for c in df.columns:
        t = XLSX_TO_INTERMEDIATE_HEADER.get(c) or XLSX_TO_INTERMEDIATE_HEADER.get(str(c).lower())
        if t:
            rename[c] = t
    df = df.rename(columns=rename)
    tab = INTERMEDIATE_TABS[sheet_id]
    keep = ["日期"] + COMMON_DIMS + ["机型ID", "机型名称"] + tab["extra_dims"] + tab["metrics"]
    for c in keep:
        if c not in df.columns:
            df[c] = 0 if c in tab["metrics"] else ""
    df = df[keep].copy()
    df["日期"] = pd.to_datetime(df["日期"]).dt.date
    for m in tab["metrics"]:
        df[m] = pd.to_numeric(df[m], errors="coerce").fillna(0)
    return df


def load_raw_by_tab(zip_paths: list[Path]) -> dict[str, pd.DataFrame]:
    dfs: dict[str, list[pd.DataFrame]] = {sid: [] for sid in INTERMEDIATE_TABS}
    workdir = Path(tempfile.mkdtemp(prefix="pipeline_"))
    try:
        for zp in zip_paths:
            sub = workdir / zp.stem
            sub.mkdir()
            with zipfile.ZipFile(zp) as zf:
                zf.extractall(sub)
            for xlsx in sub.glob("*.xlsx"):
                df = pd.read_excel(xlsx)
                if df.empty:
                    continue
                sid = _route_by_cols(list(df.columns))
                dfs[sid].append(_normalize_xlsx_df(df, sid))
        return {sid: (pd.concat(v, ignore_index=True) if v else pd.DataFrame()) for sid, v in dfs.items()}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ============================================================
# ISO 周聚合
# ============================================================
def _iso_week_str(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _iso_week_bounds(week: str) -> tuple[str, str]:
    y, w = week.split("-W")
    y, w = int(y), int(w)
    mon = date.fromisocalendar(y, w, 1)
    sun = date.fromisocalendar(y, w, 7)
    return mon.isoformat(), sun.isoformat()


def aggregate_by_week(raw_by_tab: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """按 (统计周, 机型+dims) group sum, 加「已收到天数」列.
    输入 df 已归属单月 (调用方拆).
    输出列 = 统计周, 周开始, 周结束, 机型ID, 机型名称, extra_dims, 已收到天数, <metrics 汇总>
    """
    result: dict[str, pd.DataFrame] = {}
    for sid, df in raw_by_tab.items():
        if df.empty:
            result[sid] = pd.DataFrame()
            continue
        tab = INTERMEDIATE_TABS[sid]
        df = df.copy()
        df["统计周"] = df["日期"].map(_iso_week_str)
        key_cols = ["统计周"] + COMMON_DIMS + ["机型ID", "机型名称"] + tab["extra_dims"]
        sum_df = df.groupby(key_cols, dropna=False)[tab["metrics"]].sum().reset_index()
        days_df = df.groupby(key_cols, dropna=False)["日期"].nunique().reset_index(name="已收到天数")
        merged = sum_df.merge(days_df, on=key_cols)
        # 加 周开始 / 周结束 列
        merged["周开始"] = merged["统计周"].map(lambda w: _iso_week_bounds(w)[0])
        merged["周结束"] = merged["统计周"].map(lambda w: _iso_week_bounds(w)[1])
        # 指标列改名加"汇总"后缀
        merged = merged.rename(columns={m: f"{m}汇总" for m in tab["metrics"]})
        ordered = (
            ["统计周", "周开始", "周结束"]
            + COMMON_DIMS
            + ["机型ID", "机型名称"]
            + tab["extra_dims"]
            + ["已收到天数"]
            + [f"{m}汇总" for m in tab["metrics"]]
        )
        result[sid] = merged[ordered]
    return result


# ============================================================
# 按月拆 raw
# ============================================================
def _week_home_month(d: date) -> str:
    """该 stat_date 所在 ISO 周的周一所在月. 一个 ISO 周整体归属周一所在月."""
    y, w, _ = d.isocalendar()
    monday = date.fromisocalendar(y, w, 1)
    return month_key(monday)


def split_by_month(raw_by_tab: dict[str, pd.DataFrame]) -> dict[str, dict[str, pd.DataFrame]]:
    """→ {month: {sheet_id: df}}. 按 ISO 周的周一所在月归属, 不按 stat_date 拆."""
    result: dict[str, dict[str, pd.DataFrame]] = {}
    for sid, df in raw_by_tab.items():
        if df.empty:
            continue
        df = df.copy()
        df["_home_month"] = df["日期"].map(_week_home_month)
        for month, sub in df.groupby("_home_month"):
            result.setdefault(month, {})[sid] = sub.drop(columns=["_home_month"]).reset_index(drop=True)
    return result


# ============================================================
# 分批 csv-put + retry
# ============================================================
def _csv_put_batched(token: str, sheet_id: str, start_row: int, df_new: pd.DataFrame, budget: UpsertBudget | None = None) -> None:
    """写 df_new 到 [start_row, start_row+len). 每批 CSV_PUT_BATCH 行, 出错走 retry."""
    total = len(df_new)
    n_batches = (total + CSV_PUT_BATCH - 1) // CSV_PUT_BATCH
    tolerated: list[int] = []  # batch idx 里出现过 timeout 但被容忍的
    consecutive_tolerated = 0
    for bi, offset in enumerate(range(0, total, CSV_PUT_BATCH)):
        if budget:
            budget.check("csv-put")
        chunk = df_new.iloc[offset : offset + CSV_PUT_BATCH]
        start_cell = f"A{start_row + offset}"
        buf = io.StringIO()
        chunk.to_csv(buf, index=False, header=False, lineterminator=chr(10))
        csv_text = buf.getvalue()
        t0 = time.time()
        last_err: Exception | None = None
        for attempt in range(CSV_PUT_RETRY):
            try:
                sheets_csv_put(token, sheet_id, start_cell, csv_text)
                last_err = None
                break
            except LarkError as e:
                last_err = e
                msg = str(e).lower()
                if (
                    "timeout" in msg
                    or "network error" in msg
                    or "recommited" in msg
                    or "rev is" in msg
                    or "900015205" in msg
                    or "1204" in msg
                    or "601125300" in msg
                ):
                    print(f"[csv-put] batch {bi+1}/{n_batches} attempt {attempt+1}/{CSV_PUT_RETRY} transient: {str(e)[:80]}", flush=True)
                    time.sleep(CSV_PUT_RETRY_BACKOFF * (2 ** attempt))
                    continue
                raise
        batch_tolerated = False
        if last_err:
            # 5 次全 transient 后仍失败: 只能视为 pending_verify, 不能无限继续放大服务端拥堵。
            print(f"[csv-put] batch {bi+1}/{n_batches} TOLERATED after {CSV_PUT_RETRY} attempts: {str(last_err)[:80]}", flush=True)
            tolerated.append(bi)
            consecutive_tolerated += 1
            batch_tolerated = True
            if consecutive_tolerated >= CSV_PUT_CONSECUTIVE_TOLERATED_ABORT:
                raise LarkError(
                    f"csv-put circuit breaker: {consecutive_tolerated} consecutive tolerated batches "
                    f"ending at batch {bi+1}/{n_batches}; abort to avoid worsening Feishu sheet backend congestion"
                )
        else:
            consecutive_tolerated = 0
        if bi == 0 or (bi + 1) % 10 == 0 or bi + 1 == n_batches or batch_tolerated:
            status = "TOLERATED" if batch_tolerated else "ok"
            print(f"[csv-put] batch {bi+1}/{n_batches} {status} start_cell={start_cell} rows={len(chunk)} elapsed={time.time()-t0:.1f}s", flush=True)
    if tolerated:
        # spot-check: 挑每个 tolerated batch 的首行验证是不是真的写进去了 (idempotent)
        sample_bad: list[int] = []
        for bi in tolerated:
            if budget:
                budget.check("csv-put tolerated verify")
            row = start_row + bi * CSV_PUT_BATCH
            try:
                got = _csv_get_retry(token, sheet_id, f"A{row}:A{row}")
                # csv_get 返回 "[row=N] value" 格式; 判断 value 是否为空
                first = got.strip().splitlines()[0] if got.strip() else ""
                val = first.split("] ", 1)[1] if "] " in first else first
                if not val.strip():
                    sample_bad.append(row)
            except Exception:
                sample_bad.append(row)
        if sample_bad:
            raise LarkError(f"csv-put tolerated batches lost data at rows: {sample_bad[:5]}")
        print(f"[csv-put] {len(tolerated)} tolerated batches verified OK by spot-check", flush=True)

    # ---- FINAL row-count hard verification (per master requirement) ----
    # After all batches, sample 5% of batches (min 3) and verify their FIRST row col A non-empty.
    # This catches silent losses beyond just tolerated batches - e.g. batches that "returned ok"
    # but where the API layer got a corrupted response and actually didn't commit.
    import random as _rnd
    sample_size = max(3, n_batches // 20)  # 5% or min 3
    if n_batches <= sample_size:
        sample_idx = list(range(n_batches))
    else:
        # deterministic first + last + random middle picks
        sample_idx = sorted(set([0, n_batches - 1] + _rnd.sample(range(1, n_batches - 1), max(0, sample_size - 2))))
    final_bad: list[int] = []
    for bi in sample_idx:
        if budget:
            budget.check("csv-put final verify")
        row = start_row + bi * CSV_PUT_BATCH
        try:
            got = _csv_get_retry(token, sheet_id, f"A{row}:A{row}")
            first = got.strip().splitlines()[0] if got.strip() else ""
            val = first.split("] ", 1)[1] if "] " in first else first
            if not val.strip():
                final_bad.append(row)
        except Exception:
            final_bad.append(row)
    if final_bad:
        raise LarkError(f"csv-put FINAL verify: rows appear empty: {final_bad[:5]} (sampled {len(sample_idx)}/{n_batches})")
    print(f"[csv-put] FINAL verify OK: sampled {len(sample_idx)}/{n_batches} batches, all A col non-empty", flush=True)


def _is_transient_sheet_error(e: Exception) -> bool:
    msg = str(e).lower()
    return (
        "timeout" in msg
        or "network error" in msg
        or "1204" in msg
        or "429" in msg
        or "rate" in msg
        or "server_error" in msg
        or "20050" in msg
        or "invalid json response" in msg
        or "601125300" in msg
    )


def _ensure_capacity(token: str, sheet_id: str, need_last_row: int, budget: UpsertBudget | None = None) -> None:
    """扩容至 need_last_row + 100 buffer.

    飞书 dim-insert 单次 batch 必须 **严格小于** 当前 row_count (batch == row_count 也失败).
    策略: batch = min(row_count // 2, remaining, DIM_INSERT_BATCH). log2 增长.
    """
    try:
        sheets = sheets_workbook_info(token)
        row_count = next(s["row_count"] for s in sheets if s["sheet_id"] == sheet_id)
    except LarkError as e:
        if _is_transient_sheet_error(e):
            return
        raise
    target = need_last_row + 100
    while row_count < target:
        if budget:
            budget.check("ensure capacity")
        # row_count // 2 保证 batch < row_count; 用 max 兜底防止 row_count=1 时 batch=0
        allowed = max(1, row_count // 2)
        batch = min(allowed, target - row_count, DIM_INSERT_BATCH)
        # 飞书 API 对大表 dim-insert 客户端 14s timeout,服务端通常仍生效。
        # 用前后 row_count 差判断真实结果,忽略 transient timeout。
        api_err = None
        try:
            sheets_dim_insert(token, sheet_id, position=row_count, count=batch)
        except LarkError as e:
            api_err = e
        time.sleep(2)
        try:
            rc_after = next(s["row_count"] for s in sheets_workbook_info(token) if s["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            rc_after = None
        if rc_after is not None and rc_after > row_count:
            actual = rc_after - row_count
            print(f"[ensure-cap] insert ok pos={row_count} batch={batch} actual={actual} rc->{rc_after}", flush=True)
            row_count = rc_after
            continue
        if api_err is not None:
            raise api_err
        row_count += batch




def _ensure_columns(token: str, sheet_id: str, need_cols: int) -> int:
    """删除模板尾部多余空列, 避免宽模板消耗整本表单元格额度."""
    try:
        sheets = sheets_workbook_info(token)
        col_count = next(s["column_count"] for s in sheets if s["sheet_id"] == sheet_id)
    except LarkError as e:
        if _is_transient_sheet_error(e):
            return 0
        raise
    if col_count <= need_cols:
        return 0
    sheets_dim_delete(token, sheet_id, f"{col_letter(need_cols + 1)}:{col_letter(col_count)}")
    return col_count - need_cols


def _summary_col_count(sheet_id: str) -> int:
    tab = INTERMEDIATE_TABS[sheet_id]
    return len(["统计周", "周开始", "周结束"] + COMMON_DIMS + ["机型ID", "机型名称"] + tab["extra_dims"] + ["已收到天数"] + [f"{m}汇总" for m in tab["metrics"]])


def _daily_col_count(sheet_id: str) -> int:
    tab = INTERMEDIATE_TABS[sheet_id]
    return len(["统计周", "周开始", "周结束"] + COMMON_DIMS + ["机型ID", "机型名称"] + tab["extra_dims"] + [f"{m}日均" for m in tab["metrics"]])


def _prepare_workbook_columns(summary_token: str | None, daily_token: str | None) -> dict[str, int]:
    """先裁掉所有目标 tab 的尾部空列, 包括本次没有数据的 tab."""
    shrunk: dict[str, int] = {}
    if summary_token:
        for sid in INTERMEDIATE_TABS:
            shrunk[f"summary/{sid}"] = _ensure_columns(summary_token, sid, _summary_col_count(sid))
    if daily_token:
        for sid in INTERMEDIATE_TABS:
            daily_sid = SUMMARY_TO_DAILY_AVG_SID[sid]
            shrunk[f"daily/{daily_sid}"] = _ensure_columns(daily_token, daily_sid, _daily_col_count(sid))
    return shrunk


def _cells_clear_retry(token: str, sheet_id: str, range_: str) -> None:
    last_err: Exception | None = None
    for attempt in range(CSV_PUT_RETRY):
        try:
            sheets_cells_clear(token, sheet_id, range_)
            return
        except LarkError as e:
            last_err = e
            msg = str(e).lower()
            if _is_transient_sheet_error(e):
                time.sleep(CSV_PUT_RETRY_BACKOFF * (2 ** attempt))
                continue
            raise
    if last_err:
        raise last_err


def _csv_get_retry(token: str, sheet_id: str, range_: str) -> str:
    last_err: Exception | None = None
    for attempt in range(CSV_PUT_RETRY):
        try:
            return sheets_csv_get(token, sheet_id, range_)
        except LarkError as e:
            last_err = e
            msg = str(e).lower()
            if _is_transient_sheet_error(e):
                time.sleep(CSV_PUT_RETRY_BACKOFF * (2 ** attempt))
                continue
            raise
    if last_err:
        raise last_err
    return ""


def _iter_a_col_rows(token: str, sheet_id: str, start_row: int = 1, max_row: int | None = None, budget: UpsertBudget | None = None):
    if max_row is None:
        try:
            _sheets = sheets_workbook_info(token)
            max_row = next(s["row_count"] for s in _sheets if s["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            max_row = MAX_SCAN_ROW
    for start in range(start_row, max_row + 1, CSV_GET_ROW_BATCH):
        if budget:
            budget.check("A-column scan")
        end = min(start + CSV_GET_ROW_BATCH - 1, max_row)
        csv = _csv_get_retry(token, sheet_id, f"A{start}:A{end}")
        for line in csv.splitlines():
            if not line.startswith("[row="):
                continue
            n_str, _, rest = line[len("[row="):].partition("] ")
            try:
                n = int(n_str)
            except ValueError:
                continue
            yield n, rest



def _clear_tail_week(token: str, sheet_id: str, target_week: str, budget: UpsertBudget | None = None) -> tuple[int, bool]:
    """Fast path: if target_week occupies only a contiguous tail segment, one dim-delete kills it.
    Returns (cleared_rows, took_fast_path).
      took_fast_path=True  -> already deleted, cleared_rows is the count
      took_fast_path=False -> no change, caller must fallback to _clear_rows_matching_weeks
    """
    try:
        sheets = sheets_workbook_info(token)
        max_row = next(s["row_count"] for s in sheets if s["sheet_id"] == sheet_id)
    except (LarkError, StopIteration):
        return 0, False
    if max_row < 2:
        return 0, True

    boundary_first = None
    saw_target = False
    scan_end = max_row
    while scan_end >= 2:
        if budget:
            budget.check("tail scan")
        scan_start = max(2, scan_end - CSV_GET_ROW_BATCH + 1)
        csv = _csv_get_retry(token, sheet_id, f"A{scan_start}:A{scan_end}")
        rows: list[tuple[int, str]] = []
        for line in csv.splitlines():
            if not line.startswith("[row="):
                continue
            n_str, _, rest = line[len("[row="):].partition("] ")
            try:
                n = int(n_str)
            except ValueError:
                continue
            rows.append((n, rest.strip()))
        rows.sort(key=lambda x: x[0], reverse=True)
        found_non_target = False
        for n, w in rows:
            if not w:
                continue
            if w == target_week:
                saw_target = True
                continue
            boundary_first = n + 1
            found_non_target = True
            break
        if found_non_target:
            break
        scan_end = scan_start - 1

    if not saw_target:
        # tail is empty or has no target_week at all
        return 0, False if scan_end >= 2 else True

    if boundary_first is None:
        # scanned all the way and every non-empty row is target_week
        boundary_first = 2

    to_delete = max_row - boundary_first + 1
    if to_delete <= 0:
        return 0, True
    print(f"[tail-fast] {sheet_id} boundary_first={boundary_first} max_row={max_row} to_delete={to_delete}", flush=True)
    remaining = to_delete
    while remaining > 0:
        batch = min(DIM_DELETE_BATCH, remaining)
        start_of_batch = boundary_first + remaining - batch
        # 飞书 API 对大表 dim-delete 客户端 14s timeout,但服务端删除通常仍生效。
        # 用前后 row_count 差值判断真实结果,忽略 transient timeout 错误。
        try:
            rc_before = next(s["row_count"] for s in sheets_workbook_info(token) if s["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            rc_before = None
        api_err = None
        try:
            sheets_dim_delete(token, sheet_id, f"{start_of_batch}:{start_of_batch + batch - 1}")
        except LarkError as e:
            api_err = e
        # 等服务端消化后核对
        time.sleep(2)
        try:
            rc_after = next(s["row_count"] for s in sheets_workbook_info(token) if s["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            rc_after = None
        if rc_before is not None and rc_after is not None:
            actual_delta = rc_before - rc_after
            if actual_delta == batch:
                # 服务端确认删除成功,忽略客户端 API 报错
                print(f"[tail-fast] batch ok start={start_of_batch} batch={batch} rc {rc_before}->{rc_after}", flush=True)
                remaining -= batch
                continue
            elif actual_delta == 0 and api_err is not None:
                # 真的没删除
                raise api_err
            elif 0 < actual_delta < batch:
                # 部分删除:调整 remaining,下一轮再补
                print(f"[tail-fast] partial start={start_of_batch} batch={batch} actual={actual_delta} rc {rc_before}->{rc_after}", flush=True)
                remaining -= actual_delta
                continue
            else:
                # actual_delta > batch:异常,回退
                raise RuntimeError(f"tail-fast unexpected delta {actual_delta} for batch {batch}")
        # workbook-info 也拿不到,只能相信 API 或抛出
        if api_err is not None:
            raise api_err
        remaining -= batch
    return to_delete, True


def _clear_rows_matching_weeks(token: str, sheet_id: str, weeks: set[str], clear_cols: int, budget: UpsertBudget | None = None) -> int:
    """删除 A 列属于 weeks 的旧行 (dim-delete 整段, 不是 cells-clear 逐行).

    实现要点:
      1. 扫 A 列找出所有匹配的行号 -> to_clear
      2. 合并连续行号为若干 (start, end) 段
      3. **从底往上**逐段 dim-delete (从高行号先删, 避免下面段的行号漂移)
      4. 每段内部按 DIM_DELETE_BATCH (5000) 再切, 每 batch 前后取 row_count 对差,
         忽略 transient timeout (与 _ensure_capacity 同思路)
    """
    to_clear: list[int] = []
    for n, rest in _iter_a_col_rows(token, sheet_id, start_row=2, budget=budget):
        if rest.strip() in weeks:
            to_clear.append(n)
    if not to_clear:
        return 0
    to_clear.sort()
    segments: list[tuple[int, int]] = []
    seg_start = seg_end = to_clear[0]
    for n in to_clear[1:]:
        if n == seg_end + 1:
            seg_end = n
        else:
            segments.append((seg_start, seg_end))
            seg_start = seg_end = n
    segments.append((seg_start, seg_end))
    total_target = sum(e - s + 1 for s, e in segments)
    print(f"[clear-weeks] {sheet_id} weeks={sorted(weeks)} matched_rows={len(to_clear)} segments={len(segments)} total={total_target}", flush=True)

    # 从底往上删: 大行号先, 避免行号漂移
    actual_deleted = 0
    for si, (s, e) in enumerate(sorted(segments, key=lambda x: -x[0])):
        seg_len = e - s + 1
        remaining = seg_len
        # 段内从底往上分批删
        while remaining > 0:
            batch = min(DIM_DELETE_BATCH, remaining)
            start_of_batch = s + remaining - batch  # 本 batch 的首行号 (行号相对本段, 且此刻表结构未变)
            end_of_batch = start_of_batch + batch - 1
            try:
                rc_before = next(x["row_count"] for x in sheets_workbook_info(token) if x["sheet_id"] == sheet_id)
            except (LarkError, StopIteration):
                rc_before = None
            api_err: Exception | None = None
            try:
                sheets_dim_delete(token, sheet_id, f"{start_of_batch}:{end_of_batch}")
            except LarkError as ex:
                api_err = ex
            time.sleep(2)
            try:
                rc_after = next(x["row_count"] for x in sheets_workbook_info(token) if x["sheet_id"] == sheet_id)
            except (LarkError, StopIteration):
                rc_after = None
            if rc_before is not None and rc_after is not None:
                delta = rc_before - rc_after
                if delta == batch:
                    print(f"[clear-weeks] seg {si+1}/{len(segments)} batch ok rows {start_of_batch}:{end_of_batch} rc {rc_before}->{rc_after}", flush=True)
                    actual_deleted += batch
                    remaining -= batch
                    continue
                elif delta == 0 and api_err is not None:
                    raise api_err
                elif 0 < delta < batch:
                    print(f"[clear-weeks] seg {si+1}/{len(segments)} partial rows {start_of_batch}:{end_of_batch} actual={delta} rc {rc_before}->{rc_after}", flush=True)
                    actual_deleted += delta
                    remaining -= delta
                    continue
                else:
                    raise RuntimeError(f"clear-weeks unexpected delta {delta} for batch {batch}")
            # workbook-info 都拿不到, 只能相信 API 或抛出
            if api_err is not None:
                raise api_err
            actual_deleted += batch
            remaining -= batch
    return actual_deleted


def _last_data_row(token: str, sheet_id: str, budget: UpsertBudget | None = None) -> int:
    last = 1
    for n, rest in _iter_a_col_rows(token, sheet_id, start_row=1, budget=budget):
        if rest.strip():
            last = max(last, n)
    return last


def _shrink_trailing_empty(token: str, sheet_id: str, keep_until_row: int, budget: UpsertBudget | None = None) -> int:
    """删除 keep_until_row + SHRINK_BUFFER 之后的所有 (空) 行, 防止 row_count 累积膨胀.
    每批 dim-delete 后用 workbook-info rc-diff 判断真实结果 (服务端删除通常仍生效, 忽略客户端 14s timeout).
    返回真实删除行数.
    """
    try:
        sheets = sheets_workbook_info(token)
        row_count = next(s["row_count"] for s in sheets if s["sheet_id"] == sheet_id)
    except LarkError as e:
        if _is_transient_sheet_error(e):
            print(f"[shrink] {sheet_id} workbook-info transient err skip: {e}", flush=True)
            return 0
        raise
    keep_row = keep_until_row + SHRINK_BUFFER
    if row_count <= keep_row:
        print(f"[shrink] {sheet_id} rc={row_count} keep={keep_row} nothing to do", flush=True)
        return 0
    to_delete_total = row_count - keep_row
    print(f"[shrink] {sheet_id} rc={row_count} keep={keep_row} to_delete={to_delete_total}", flush=True)
    actual_deleted = 0
    remaining = to_delete_total
    while remaining > 0:
        if budget:
            budget.check("shrink")
            budget.count_delete_batch("shrink")
        batch = min(DIM_DELETE_BATCH, remaining)
        # 每次删的是当前表尾 [keep_row+1 .. keep_row+batch]
        try:
            rc_before = next(x["row_count"] for x in sheets_workbook_info(token) if x["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            rc_before = None
        api_err: Exception | None = None
        try:
            sheets_dim_delete(token, sheet_id, f"{keep_row + 1}:{keep_row + batch}")
        except LarkError as ex:
            api_err = ex
        time.sleep(2)
        try:
            rc_after = next(x["row_count"] for x in sheets_workbook_info(token) if x["sheet_id"] == sheet_id)
        except (LarkError, StopIteration):
            rc_after = None
        if rc_before is not None and rc_after is not None:
            delta = rc_before - rc_after
            if delta == batch:
                print(f"[shrink] batch ok rows {keep_row+1}:{keep_row+batch} rc {rc_before}->{rc_after}", flush=True)
                actual_deleted += batch
                remaining -= batch
                continue
            elif delta == 0 and api_err is not None:
                raise api_err
            elif 0 < delta < batch:
                print(f"[shrink] partial rows {keep_row+1}:{keep_row+batch} actual={delta} rc {rc_before}->{rc_after}", flush=True)
                actual_deleted += delta
                remaining -= delta
                continue
            else:
                raise RuntimeError(f"shrink unexpected delta {delta} for batch {batch}")
        # workbook-info 都拿不到, 相信 API
        if api_err is not None:
            raise api_err
        actual_deleted += batch
        remaining -= batch
    print(f"[shrink] {sheet_id} done actual_deleted={actual_deleted}", flush=True)
    return actual_deleted


# ============================================================
# upsert 汇总 / 日均 (通用)
# ============================================================
def upsert_tab(token: str, sheet_id: str, df_out: pd.DataFrame, weeks: set[str], label: str) -> dict:
    if df_out.empty:
        print(f"[upsert] {label} empty", flush=True)
        return {"status": "empty", "label": label}
    print(f"[upsert] {label} rows={len(df_out)} cols={len(df_out.columns)} start", flush=True)
    budget = UpsertBudget(label)
    shrunk_cols = 0
    print(f"[upsert] {label} ensure_columns skipped", flush=True)
    took_fast = False
    cleared = 0
    if len(weeks) == 1:
        (only_week,) = tuple(weeks)
        try:
            cleared, took_fast = _clear_tail_week(token, sheet_id, only_week, budget=budget)
            if took_fast:
                print(f"[upsert] {label} tail-fast cleared_rows={cleared}", flush=True)
        except Exception as e:
            print(f"[upsert] {label} tail-fast failed: {e}, fallback to full scan", flush=True)
            took_fast = False
    if not took_fast:
        cleared = _clear_rows_matching_weeks(token, sheet_id, weeks, len(df_out.columns), budget=budget)
        print(f"[upsert] {label} cleared_rows={cleared} (full-scan)", flush=True)
    last = _last_data_row(token, sheet_id)
    print(f"[upsert] {label} last_data_row={last}", flush=True)
    _ensure_capacity(token, sheet_id, last + len(df_out))
    start_row = last + 1
    print(f"[upsert] {label} csv_put start_row={start_row}", flush=True)
    _csv_put_batched(token, sheet_id, start_row, df_out)
    print(f"[upsert] {label} csv_put done", flush=True)
    # upsert 完成后 shrink 多余空行, 避免 row_count 单调累积.
    # 见文件顶部 "设计守则 #2" - 若禁用会导致 tab row_count 永远只增不减, 崩一次污染永久.
    new_last = start_row + len(df_out) - 1
    try:
        shrunk = _shrink_trailing_empty(token, sheet_id, new_last)
    except Exception as e:
        # shrink 失败不阻断 upsert (数据已写好); 下次 upsert 再收
        print(f"[upsert] {label} shrink FAILED (non-fatal): {e!r}", flush=True)
        shrunk = 0
    print(f"[upsert] {label} shrunk_rows={shrunk}", flush=True)
    return {
        "status": "ok",
        "label": label,
        "cleared_rows": cleared,
        "inserted_rows": len(df_out),
        "start_row": start_row,
        "shrunk_rows": shrunk,
        "shrunk_cols": shrunk_cols,
    }


def _to_daily_avg_df(df_summary: pd.DataFrame, sheet_id: str) -> pd.DataFrame:
    """汇总 df → 日均 df (指标列除以 已收到天数, rename 后缀).
    日均表 header: 统计周,周开始,周结束,机型ID,机型名称,extra_dims,<metric>日均
    (日均表没有 已收到天数 列!)
    """
    if df_summary.empty:
        return df_summary
    tab = INTERMEDIATE_TABS[sheet_id]
    df = df_summary.copy()
    days = df["已收到天数"].replace(0, 1)
    for m in tab["metrics"]:
        df[f"{m}日均"] = (df[f"{m}汇总"] / days).round(4)
    key_cols = ["统计周", "周开始", "周结束"] + COMMON_DIMS + ["机型ID", "机型名称"] + tab["extra_dims"]
    return df[key_cols + [f"{m}日均" for m in tab["metrics"]]]


# ============================================================
# 单月 worker
# ============================================================
def process_month(month: str, tab_dfs: dict[str, pd.DataFrame]) -> dict:
    """月 worker: aggregate + upsert 汇总 + upsert 日均. 每月一次调用."""
    summary_token = summary_token_for(_month_to_date(month))
    daily_token = daily_avg_token_for(_month_to_date(month))
    result: dict[str, Any] = {"month": month, "tabs": {}}
    if not summary_token and not daily_token:
        result["status"] = "no_target"
        return result

    result["prepared_cols"] = {"skipped": "workbook-info is unstable on large sheets; per-tab column trim still runs during upsert"}
    agg = aggregate_by_week(tab_dfs)
    print(f"[month] {month} aggregate done", flush=True)
    # 只保留每个 tab 里最新的"统计周" —— 历史周由手动/首次导入负责,
    # 定时 pipeline 只推进最新在进行的一周,避免用残缺数据(zip 是滚动窗口)覆盖完整周.
    latest_week = None
    for df in agg.values():
        if df.empty: continue
        w = df["统计周"].max()
        if latest_week is None or w > latest_week:
            latest_week = w
    print(f"[month] {month} latest_week={latest_week}", flush=True)
    if latest_week is not None:
        agg = {sid: df[df["统计周"] == latest_week].reset_index(drop=True) if not df.empty else df
               for sid, df in agg.items()}
    weeks = {latest_week} if latest_week is not None else set()
    result["weeks"] = sorted(weeks)

    for sid in INTERMEDIATE_TABS:
        df_sum = agg.get(sid, pd.DataFrame())
        daily_sid = SUMMARY_TO_DAILY_AVG_SID[sid]
        tab_result: dict[str, Any] = {}
        if summary_token:
            try:
                tab_result["summary"] = upsert_tab(summary_token, sid, df_sum, weeks, f"{month}/summary/{sid}")
            except Exception as e:
                # 单 tab 失败不阻断后续 tab: 记录并继续
                tab_result["summary"] = {"status": "error", "error": f"{month}/summary/{sid}: {e!r}"}
                print(f"[month] {month}/summary/{sid} FAILED: {e!r}", flush=True)
        if daily_token:
            df_avg = _to_daily_avg_df(df_sum, sid)
            try:
                tab_result["daily_avg"] = upsert_tab(daily_token, daily_sid, df_avg, weeks, f"{month}/daily/{daily_sid}")
            except Exception as e:
                tab_result["daily_avg"] = {"status": "error", "error": f"{month}/daily/{daily_sid}: {e!r}"}
                print(f"[month] {month}/daily/{daily_sid} FAILED: {e!r}", flush=True)
        result["tabs"][sid] = tab_result
    any_err = any(
        (isinstance(v.get("summary"), dict) and v["summary"].get("status") == "error")
        or (isinstance(v.get("daily_avg"), dict) and v["daily_avg"].get("status") == "error")
        for v in result["tabs"].values()
    )
    result["status"] = "partial" if any_err else "ok"
    return result


def _month_to_date(month: str) -> date:
    y, m = month.split("-")
    return date(int(y), int(m), 1)


# ============================================================
# 主入口
# ============================================================
def _default_lookback_months() -> set[str]:
    today = date.today()
    return {month_key(today), month_key(today - timedelta(days=30))}


def run_pipeline(
    target_months: set[str] | None = None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    concurrency: int = MONTH_CONCURRENCY,
) -> dict:
    print(f"[pipeline] fetch zips lookback_days={lookback_days}", flush=True)
    zips = fetch_recent_zips(lookback_days=lookback_days)
    print(f"[pipeline] zips={[z.name for z in zips]}", flush=True)
    if not zips:
        return {"status": "no_email"}
    print("[pipeline] load raw start", flush=True)
    raw = load_raw_by_tab(zips)
    print("[pipeline] load raw done", flush=True)
    by_month = split_by_month(raw)
    print(f"[pipeline] split months={sorted(by_month.keys())}", flush=True)

    # target_months 可选过滤
    if target_months:
        by_month = {m: v for m, v in by_month.items() if m in target_months}

    if not by_month:
        return {"status": "no_data_in_target_months", "zips": [z.name for z in zips]}

    results: dict[str, Any] = {}
    if len(by_month) == 1 or concurrency <= 1:
        for m, tab_dfs in by_month.items():
            try:
                results[m] = process_month(m, tab_dfs)
            except Exception as e:
                results[m] = {"month": m, "status": "error", "error": repr(e)}
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = {ex.submit(process_month, m, tab_dfs): m for m, tab_dfs in by_month.items()}
            for fut in as_completed(futures):
                m = futures[fut]
                try:
                    results[m] = fut.result()
                except Exception as e:
                    results[m] = {"month": m, "status": "error", "error": repr(e)}

    overall_status = "partial" if any(r.get("status") in {"partial", "error"} for r in results.values()) else "ok"
    return {
        "status": overall_status,
        "zips": [z.name for z in zips],
        "months": sorted(by_month.keys()),
        "by_month": results,
    }


# ============================================================
# Online local CSV pipeline
# ============================================================
def _month_from_frame(df: pd.DataFrame) -> str | None:
    if df.empty:
        return None

    # New AI小万 mail snapshots use week_start_date + day_cnt rather than a
    # natural-date column.  The file belongs to the ISO week home month.
    for col in ("日期", "week_start_date", "周开始", "开始日期"):
        if col in df.columns:
            d = pd.to_datetime(df[col], errors="coerce").dropna()
            if not d.empty:
                first = d.dt.date.iloc[0]
                if hasattr(first, "isocalendar"):
                    iso = first.isocalendar()
                    monday = date.fromisocalendar(iso.year, iso.week, 1)
                    return month_key(monday)

    for col in ("统计周", "周次", "week"):
        if col not in df.columns:
            continue
        series = df[col].dropna().astype(str)
        if series.empty:
            continue
        week = series.iloc[0].strip()
        if not week:
            continue
        if re.fullmatch(r"W\d{1,2}", week):
            week = f"{date.today().year}-{week.upper().replace('W', 'W')}"
        y, w = week.split("-W")
        monday = date.fromisocalendar(int(y), int(w), 1)
        return month_key(monday)
    return None


def _attachment_preference(name: str) -> int:
    lower = name.lower()
    if lower.endswith(".zip"):
        return 0
    if lower.endswith(".xlsx"):
        return 1
    return 99


def _cache_attachment(source_key: str, uid: str, attachment_name: str) -> Path:
    # Keep the human filename suffix for debugging, but prevent accidental path
    # traversal or platform-sensitive separators from mailbox data.
    safe_name = re.sub(r"[\\/]+", "_", attachment_name).strip()
    return CACHE_DIR / f"{source_key}_{uid}_{safe_name}"


def fetch_recent_zips_by_subject(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> tuple[dict[str, list[Path]], dict[str, Any]]:
    from data_tools.email_reader import _connect, _list_attachments_meta

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    since = (date.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    zips_by_source: dict[str, list[Path]] = {}
    mail_metadata: dict[str, Any] = {"since": since, "sources": {}, "mail_count": 0}

    for source in required_sources():
        emails = list_emails(subject_contains=source.subject_contains, since=since, max_results=20, include_attachments=False)
        matched = [em for em in emails if source.subject_contains in em.subject]
        if not matched:
            continue

        # Emails are returned newest-first.  For weekly cumulative snapshots we
        # must use only the newest valid attachment per source; older lookback
        # matches are fallback candidates, not additional data to concatenate.
        imap = _connect()
        try:
            imap.select("INBOX")
            selected: dict[str, Any] | None = None
            for em in matched:
                atts = _list_attachments_meta(imap, em.uid.encode())
                candidates = sorted(
                    [a for a in atts if a.lower().endswith((".zip", ".xlsx"))],
                    key=_attachment_preference,
                )
                if not candidates:
                    continue
                att_name = candidates[0]
                cache_key = _cache_attachment(source.source_key, em.uid, att_name)
                if not cache_key.exists():
                    tmp = tempfile.mkdtemp(prefix=f"{source.source_key}_")
                    try:
                        path_str = download_attachment(em.uid, att_name, tmp)
                        shutil.move(path_str, cache_key)
                    finally:
                        shutil.rmtree(tmp, ignore_errors=True)
                selected = {
                    "uid": em.uid,
                    "subject": em.subject,
                    "date": em.date,
                    "attachment": att_name,
                    "cache_path": str(cache_key),
                    "available_attachments": atts,
                }
                zips_by_source[source.source_key] = [cache_key]
                break

            if selected:
                mail_metadata["sources"][source.source_key] = [selected]
                mail_metadata["mail_count"] += 1
        finally:
            try:
                imap.logout()
            except Exception:
                pass

    return zips_by_source, mail_metadata


def _read_xlsx_frames_from_zip(zip_path: Path) -> list[pd.DataFrame]:
    frames: list[pd.DataFrame] = []
    # Handle direct .xlsx files (not zipped)
    if zip_path.suffix.lower() == ".xlsx":
        df = pd.read_excel(zip_path)
        if not df.empty:
            frames.append(df)
        return frames
    workdir = Path(tempfile.mkdtemp(prefix="local_import_source_"))
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(workdir)
        xlsx_files = sorted(workdir.rglob("*.xlsx"))
        if not xlsx_files:
            raise ValueError(f"no xlsx files in {zip_path}")
        for xlsx in xlsx_files:
            df = pd.read_excel(xlsx)
            if not df.empty:
                frames.append(df)
        return frames
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def load_local_source_frames(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    """Load six online mail sources into prepared DataFrames.

    This is the adapter seam: the existing IMAP/xlsx/pandas implementation stays
    in place, but each source returns a prepared weekly DataFrame keyed by
    `mail_sources.MailSource.source_key`.
    """
    zips_by_source, mail_metadata = fetch_recent_zips_by_subject(lookback_days=lookback_days)
    frames_by_source: dict[str, pd.DataFrame] = {}
    for source in required_sources():
        source_frames: list[pd.DataFrame] = []
        for zip_path in zips_by_source.get(source.source_key, []):
            source_frames.extend(_read_xlsx_frames_from_zip(zip_path))
        if source_frames:
            frames_by_source[source.source_key] = pd.concat(source_frames, ignore_index=True)
    return frames_by_source, mail_metadata


def run_local_imports_pipeline(
    target_months: set[str] | None = None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    output_root: Path | str = Path("data/imports"),
    run_id: str | None = None,
) -> dict:
    run_id = run_id or datetime.now().strftime("%Y%m%d_%H%M%S")
    frames_by_source, mail_metadata = load_local_source_frames(lookback_days=lookback_days)
    missing = missing_required_sources(set(frames_by_source))
    if missing:
        return {
            "status": "missing_mail_sources",
            "missing": [
                {"source_key": source.source_key, "subject_contains": source.subject_contains}
                for source in missing
            ],
        }

    by_month: dict[str, dict[str, pd.DataFrame]] = {}
    for source in required_sources():
        df = frames_by_source[source.source_key]
        month = _month_from_frame(df)
        if month is None:
            return {"status": "empty_or_unmonthable_source", "source_key": source.source_key}
        if target_months and month not in target_months:
            continue
        by_month.setdefault(month, {})[source.source_key] = df

    if not by_month:
        return {"status": "no_data_in_target_months"}

    month_results = {}
    for month, outputs in sorted(by_month.items()):
        month_results[month] = write_local_imports(
            outputs=outputs,
            month=month,
            run_id=run_id if len(by_month) == 1 else f"{run_id}_{month}",
            output_root=output_root,
            mail_metadata=mail_metadata,
        )

    return {
        "status": "ok",
        "run_id": run_id,
        "months": sorted(month_results),
        "by_month": month_results,
        "mail_metadata": mail_metadata,
    }
