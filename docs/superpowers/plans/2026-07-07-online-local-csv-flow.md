# 线上本地 CSV 主链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将机型/品类/品类履约周数据线上日常链路从“大批量写飞书”改成“服务器本地 CSV + manifest 为主数据源，飞书 Base 只做校验/发布索引”。

**Architecture:** 历史回溯和线上日常拆成两条路径：历史回溯继续保留 Base 导入包与 49k 分片规则；线上日常新增 local-imports sink，复用现有 IMAP 拉取、解压、pandas 解析/聚合，把产物原子写到 `data/imports/`。飞书 Base 在线上链路中只写少量发布/校验记录，不承载每日全量明细。

**Tech Stack:** Python 3.11+、pandas、现有 `data_tools.email_reader`、现有 `skills/workflows/机型周数据/pipeline.py`、pytest、lark-cli（仅用于轻量 Base 校验索引，可关闭）。

---

## 0. Scope Check

本需求包含两个独立子系统，必须分开验收：

1. **历史回溯路径**：一次性跑历史 SQL/邮件产物，按 `base_partition_v1` 分片导入飞书 Base，供人工查验。该路径已经有 `scripts/import_weekly_base_partition_v1.py`，后续只维护，不进入每日主链路。
2. **线上日常路径**：每天从 6 封邮件生成服务器 CSV、manifest、active 指针；飞书 Base 只存发布状态和校验结果。本文只规划这条线上路径。

非目标：

- 不删除旧 Sheets；旧 Sheets 仍作为回滚/人工查验入口。
- 不在每日 cron 中执行全量 Base 明细导入。
- 不把大盘表作为线上主数据源；大盘层由品类数据求和得出，飞书大盘表只做校验基准。

---

## 1. File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `skills/workflows/机型周数据/mail_sources.py` | Create | 固化 6 封邮件主题、输出文件 key、主/备用标记、期望输出文件名。 |
| `skills/workflows/机型周数据/local_imports.py` | Create | 原子写 CSV、计算 checksum/行列数/核心指标合计、生成 manifest、更新 active 指针。 |
| `skills/workflows/机型周数据/pipeline.py` | Modify | 新增 `fetch_recent_zips_by_subject()` 和 `run_local_imports_pipeline()`；保留旧 `run_pipeline()` 写 Sheets 逻辑。 |
| `skills/workflows/机型周数据/run.py` | Modify | 新增 CLI：`--local-imports`、`--local-output-dir`、`--local-run-id`、`--publish-base-index`；默认不启用 Base 明细导入。 |
| `skills/workflows/机型周数据/notifier.py` | Modify | 通知支持 local CSV 主链路：输出目录、manifest、active 指针、Sheets 回滚链接。 |
| `scripts/tests/test_local_imports.py` | Create | 覆盖 source contract、原子写入、manifest、active 指针、防半文件读取。 |
| `scripts/tests/test_online_local_pipeline.py` | Create | 用 monkeypatch 模拟 6 封邮件和解析结果，验证只写本地 CSV，不调用 Sheets/Base 明细写入。 |
| `docs/superpowers/plans/2026-07-07-online-local-csv-flow.md` | Modify | 本实施计划。 |

---

## 2. Data Contract

### 2.1 Six-mail source contract

`mail_sources.py` 固化以下 6 个 source，任何 run 缺少一个 required source 都 fail fast：

| source_key | 邮件主题包含 | 输出文件模板 | role |
|---|---|---|---|
| `category_daily_avg` | `AI小万_品类漏斗数据周日均` | `category_daily_avg_{month}.csv` | primary |
| `model_summary` | `AI小万_机型漏斗数据周汇` | `model_summary_{month}.csv` | backup |
| `category_summary` | `AI小万_品类漏斗数据周汇` | `category_summary_{month}.csv` | backup |
| `model_daily_avg` | `AI小万_机型漏斗数据周日均` | `model_daily_avg_{month}.csv` | primary |
| `category_fulfill_daily_avg` | `AI小万_品类履约漏斗数据周日均` | `category_fulfill_daily_avg_{month}.csv` | primary |
| `category_fulfill_summary` | `AI小万_品类履约漏斗数据周汇` | `category_fulfill_summary_{month}.csv` | backup |

`role` 和 `required` 的关系必须写进代码注释：`role=primary/backup` 表示下游消费优先级，`required=True` 表示邮件输入完整性。本链路要求 6 封邮件全部产出，backup 文件虽然不一定被 model-tag-monitor 第一时间消费，但仍用于回滚、校验和后续扩展，所以 6 个 source 都是 required。

### 2.2 Local output contract

For month `2026-07`, successful run writes:

```text
data/imports/model_daily_avg_2026-07.csv
data/imports/model_summary_2026-07.csv
data/imports/category_daily_avg_2026-07.csv
data/imports/category_summary_2026-07.csv
data/imports/category_fulfill_daily_avg_2026-07.csv
data/imports/category_fulfill_summary_2026-07.csv
data/imports/manifests/<run_id>.json
data/imports/active.json
```

`active.json` is the stable downstream entry point:

```json
{
  "schema_version": 1,
  "run_id": "20260707_093000",
  "generated_at": "2026-07-07T09:30:00+08:00",
  "outputs": {
    "model_daily_avg": "data/imports/model_daily_avg_2026-07.csv",
    "model_summary": "data/imports/model_summary_2026-07.csv",
    "category_daily_avg": "data/imports/category_daily_avg_2026-07.csv",
    "category_summary": "data/imports/category_summary_2026-07.csv",
    "category_fulfill_daily_avg": "data/imports/category_fulfill_daily_avg_2026-07.csv",
    "category_fulfill_summary": "data/imports/category_fulfill_summary_2026-07.csv"
  },
  "manifest": "data/imports/manifests/20260707_093000.json"
}
```

### 2.3 Month ownership

- Weekly data belongs to the month containing that ISO week’s Monday.
- Example: W18 = 2026-04-27 to 2026-05-03, so W18 belongs to `2026-04`.
- This matches the historical Base partition rule and prevents cross-month duplicate publication.

---

## 3. Implementation Tasks

### Task 1: Add six-mail source contract

**Files:**
- Create: `skills/workflows/机型周数据/mail_sources.py`
- Test: `scripts/tests/test_local_imports.py`

- [ ] **Step 1: Write failing tests for source contract**

Create `scripts/tests/test_local_imports.py` with this initial content:

```python
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

mail_sources = importlib.import_module("skills.workflows.机型周数据.mail_sources")


def test_required_mail_sources_are_exactly_six():
    sources = mail_sources.required_sources()

    assert [source.source_key for source in sources] == [
        "category_daily_avg",
        "model_summary",
        "category_summary",
        "model_daily_avg",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]
    assert all(source.required for source in sources)
    assert sources[0].subject_contains == "AI小万_品类漏斗数据周日均"
    assert sources[1].role == "backup"
    assert sources[1].required is True
    assert sources[3].output_filename("2026-07") == "model_daily_avg_2026-07.csv"


def test_missing_required_sources_reports_subjects():
    present = {"model_daily_avg", "model_summary"}

    missing = mail_sources.missing_required_sources(present)

    assert [source.source_key for source in missing] == [
        "category_daily_avg",
        "category_summary",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]
    assert missing[0].subject_contains == "AI小万_品类漏斗数据周日均"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py -q
```

Expected:

```text
ModuleNotFoundError: No module named 'skills.workflows.机型周数据.mail_sources'
```

- [ ] **Step 3: Implement source contract**

Create `skills/workflows/机型周数据/mail_sources.py`:

```python
"""Six-mail input contract for the online local CSV workflow."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MailSource:
    source_key: str
    subject_contains: str
    filename_prefix: str
    # role controls downstream consumption priority; required controls mailbox completeness.
    # backup files are still required because they support validation, rollback, and future consumers.
    role: str
    required: bool = True

    def output_filename(self, month: str) -> str:
        if len(month) != 7 or month[4] != "-":
            raise ValueError(f"month must be YYYY-MM, got {month!r}")
        return f"{self.filename_prefix}_{month}.csv"


MAIL_SOURCES: tuple[MailSource, ...] = (
    MailSource("category_daily_avg", "AI小万_品类漏斗数据周日均", "category_daily_avg", "primary"),
    MailSource("model_summary", "AI小万_机型漏斗数据周汇", "model_summary", "backup"),
    MailSource("category_summary", "AI小万_品类漏斗数据周汇", "category_summary", "backup"),
    MailSource("model_daily_avg", "AI小万_机型漏斗数据周日均", "model_daily_avg", "primary"),
    MailSource("category_fulfill_daily_avg", "AI小万_品类履约漏斗数据周日均", "category_fulfill_daily_avg", "primary"),
    MailSource("category_fulfill_summary", "AI小万_品类履约漏斗数据周汇", "category_fulfill_summary", "backup"),
)


def required_sources() -> list[MailSource]:
    return [source for source in MAIL_SOURCES if source.required]


def source_by_key(source_key: str) -> MailSource:
    for source in MAIL_SOURCES:
        if source.source_key == source_key:
            return source
    raise KeyError(f"unknown mail source_key: {source_key}")


def missing_required_sources(present_source_keys: set[str]) -> list[MailSource]:
    return [source for source in required_sources() if source.source_key not in present_source_keys]
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py -q
```

Expected:

```text
2 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/mail_sources.py scripts/tests/test_local_imports.py
git commit -m "feat(skills): add online mail source contract"
```

---

### Task 2: Add local CSV writer, manifest, and active pointer

**Files:**
- Create: `skills/workflows/机型周数据/local_imports.py`
- Modify: `scripts/tests/test_local_imports.py`

- [ ] **Step 1: Add failing tests for atomic CSV outputs**

Append to `scripts/tests/test_local_imports.py`:

```python
import json

import pandas as pd

local_imports = importlib.import_module("skills.workflows.机型周数据.local_imports")


def test_write_local_imports_outputs_csv_manifest_and_active(tmp_path: Path):
    outputs = {
        "model_daily_avg": pd.DataFrame(
            [
                {"统计周": "2026-W27", "成交量日均": 2.5, "成交GMV日均": 300.0},
                {"统计周": "2026-W27", "成交量日均": 1.5, "成交GMV日均": 200.0},
            ]
        ),
        "model_summary": pd.DataFrame(
            [{"统计周": "2026-W27", "成交量汇总": 28, "成交GMV汇总": 3500.0}]
        ),
    }

    result = local_imports.write_local_imports(
        outputs=outputs,
        month="2026-07",
        run_id="20260707_093000",
        output_root=tmp_path,
        mail_metadata={"model_daily_avg": {"zip": "a.zip"}},
    )

    assert result["status"] == "ok"
    assert (tmp_path / "model_daily_avg_2026-07.csv").exists()
    assert (tmp_path / "model_summary_2026-07.csv").exists()
    assert not list((tmp_path / ".tmp").glob("**/*.tmp"))

    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["run_id"] == "20260707_093000"
    assert manifest["month"] == "2026-07"
    assert manifest["outputs"]["model_daily_avg"]["row_count"] == 2
    assert manifest["outputs"]["model_daily_avg"]["column_count"] == 3
    assert manifest["outputs"]["model_daily_avg"]["metric_sums"]["成交量日均"] == 4.0
    assert len(manifest["outputs"]["model_daily_avg"]["sha256"]) == 64

    active = json.loads((tmp_path / "active.json").read_text(encoding="utf-8"))
    assert active["run_id"] == "20260707_093000"
    assert active["outputs"]["model_daily_avg"].endswith("model_daily_avg_2026-07.csv")
    assert active["manifest"].endswith("manifests/20260707_093000.json")
    for csv_path in active["outputs"].values():
        assert Path(csv_path).exists()


def test_write_local_imports_does_not_update_active_when_csv_write_fails(monkeypatch, tmp_path: Path):
    old_active = {"schema_version": 1, "run_id": "old", "outputs": {}, "manifest": "old.json"}
    (tmp_path / "active.json").write_text(json.dumps(old_active), encoding="utf-8")
    outputs = {
        "model_daily_avg": pd.DataFrame([{"统计周": "2026-W27", "成交量日均": 1.0}]),
        "model_summary": pd.DataFrame([{"统计周": "2026-W27", "成交量汇总": 7.0}]),
    }
    real_atomic_write_csv = local_imports._atomic_write_csv
    calls = {"count": 0}

    def fail_on_second_csv(df, path, tmp_dir):
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("simulated csv failure")
        return real_atomic_write_csv(df, path, tmp_dir)

    monkeypatch.setattr(local_imports, "_atomic_write_csv", fail_on_second_csv)

    with pytest.raises(RuntimeError, match="simulated csv failure"):
        local_imports.write_local_imports(
            outputs=outputs,
            month="2026-07",
            run_id="20260707_093000",
            output_root=tmp_path,
        )

    active = json.loads((tmp_path / "active.json").read_text(encoding="utf-8"))
    assert active == old_active
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py::test_write_local_imports_outputs_csv_manifest_and_active -q
```

Expected:

```text
ModuleNotFoundError: No module named 'skills.workflows.机型周数据.local_imports'
```

- [ ] **Step 3: Implement local writer**

Create `skills/workflows/机型周数据/local_imports.py`:

```python
"""Local CSV sink for online weekly funnel imports."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from .mail_sources import source_by_key


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _metric_sums(df: pd.DataFrame) -> dict[str, float]:
    sums: dict[str, float] = {}
    for col in df.columns:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().any():
            sums[str(col)] = float(numeric.fillna(0).sum())
    return sums


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _atomic_write_csv(df: pd.DataFrame, path: Path, tmp_dir: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f"{path.name}.{os.getpid()}.tmp"
    df.to_csv(tmp, index=False, encoding="utf-8-sig")
    os.replace(tmp, path)


def write_local_imports(
    *,
    outputs: dict[str, pd.DataFrame],
    month: str,
    run_id: str,
    output_root: Path | str = Path("data/imports"),
    mail_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(output_root)
    tmp_dir = root / ".tmp" / run_id
    manifest_dir = root / "manifests"
    generated_at = _now_iso()
    manifest_outputs: dict[str, Any] = {}
    active_outputs: dict[str, str] = {}

    for source_key, df in outputs.items():
        source = source_by_key(source_key)
        filename = source.output_filename(month)
        output_path = root / filename
        _atomic_write_csv(df, output_path, tmp_dir)
        stat = output_path.stat()
        manifest_outputs[source_key] = {
            "path": str(output_path),
            "filename": filename,
            "row_count": int(len(df)),
            "column_count": int(len(df.columns)),
            "columns": [str(col) for col in df.columns],
            "metric_sums": _metric_sums(df),
            "sha256": _sha256(output_path),
            "bytes": int(stat.st_size),
            "role": source.role,
        }
        active_outputs[source_key] = str(output_path)

    try:
        tmp_dir.rmdir()
        (root / ".tmp").rmdir()
    except OSError:
        pass

    manifest_path = manifest_dir / f"{run_id}.json"
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "generated_at": generated_at,
        "month": month,
        "mail_metadata": mail_metadata or {},
        "outputs": manifest_outputs,
        "validation_status": "pass",
    }
    _atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))

    active = {
        "schema_version": 1,
        "run_id": run_id,
        "generated_at": generated_at,
        "outputs": active_outputs,
        "manifest": str(manifest_path),
    }
    _atomic_write_text(root / "active.json", json.dumps(active, ensure_ascii=False, indent=2, sort_keys=True))

    return {
        "status": "ok",
        "run_id": run_id,
        "month": month,
        "output_root": str(root),
        "manifest_path": str(manifest_path),
        "active_path": str(root / "active.json"),
        "outputs": manifest_outputs,
    }
```

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py -q
```

Expected:

```text
4 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/local_imports.py scripts/tests/test_local_imports.py
git commit -m "feat(skills): add local csv import writer"
```

---

### Task 3: Wire local CSV mode into the pipeline without touching Sheets mode

**Files:**
- Modify: `skills/workflows/机型周数据/pipeline.py`
- Create: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Write failing test that local mode does not call Sheets upsert**

Create `scripts/tests/test_online_local_pipeline.py`:

```python
from __future__ import annotations

import importlib
import sys
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

pipeline = importlib.import_module("skills.workflows.机型周数据.pipeline")


def test_run_local_imports_pipeline_writes_files_without_sheets(monkeypatch, tmp_path: Path):
    raw_by_source = {
        "model_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "成交量日均": 1.0}]),
        "model_summary": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "成交量汇总": 7.0}]),
        "category_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "成交量日均": 2.0}]),
        "category_summary": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "成交量汇总": 14.0}]),
        "category_fulfill_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "签收量日均": 3.0}]),
        "category_fulfill_summary": pd.DataFrame([{"日期": date(2026, 7, 1), "统计周": "2026-W27", "签收量汇总": 21.0}]),
    }

    monkeypatch.setattr(pipeline, "load_local_source_frames", lambda lookback_days: (raw_by_source, {"mail_count": 6}))

    def fail_upsert(*args, **kwargs):
        raise AssertionError("local imports mode must not call Sheets upsert")

    monkeypatch.setattr(pipeline, "upsert_tab", fail_upsert)

    result = pipeline.run_local_imports_pipeline(
        target_months={"2026-07"},
        lookback_days=14,
        output_root=tmp_path,
        run_id="20260707_093000",
    )

    assert result["status"] == "ok"
    assert result["months"] == ["2026-07"]
    assert (tmp_path / "model_daily_avg_2026-07.csv").exists()
    assert (tmp_path / "category_fulfill_summary_2026-07.csv").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py -q
```

Expected:

```text
AttributeError: module 'skills.workflows.机型周数据.pipeline' has no attribute 'run_local_imports_pipeline'
```

- [ ] **Step 3: Implement minimal local pipeline adapter**

This step creates the orchestration seam only. It is not deployable until Task 3.5 wires `load_local_source_frames()` to the real IMAP+xlsx parser.

Modify `skills/workflows/机型周数据/pipeline.py` by adding imports near existing imports:

```python
from .local_imports import write_local_imports
from .mail_sources import missing_required_sources, required_sources
```

Add these functions near the main entry section:

```python
def _month_from_frame(df: pd.DataFrame) -> str | None:
    if df.empty:
        return None
    if "日期" in df.columns:
        d = pd.to_datetime(df["日期"], errors="coerce").dropna()
        if not d.empty:
            first = d.dt.date.iloc[0]
            if hasattr(first, "isocalendar"):
                iso = first.isocalendar()
                monday = date.fromisocalendar(iso.year, iso.week, 1)
                return month_key(monday)
    if "统计周" in df.columns:
        week = str(df["统计周"].dropna().astype(str).iloc[0])
        y, w = week.split("-W")
        monday = date.fromisocalendar(int(y), int(w), 1)
        return month_key(monday)
    return None


def load_local_source_frames(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    """Load six online mail sources into prepared DataFrames.

    This is the adapter seam: the existing IMAP/xlsx/pandas implementation stays
    in place, but each source returns a prepared weekly DataFrame keyed by
    `mail_sources.MailSource.source_key`.
    """
    raise NotImplementedError("six-mail local source loader must be wired to the existing mailbox parser")


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
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py scripts/tests/test_online_local_pipeline.py -q
```

Expected:

```text
4 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/pipeline.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): add local imports pipeline mode"
```

---

### Task 3.5: Wire `load_local_source_frames` to existing IMAP+xlsx parser

**背景**：Task 3 中 `load_local_source_frames` 是 `raise NotImplementedError` 占位，测试通过是因为 monkeypatch 绕过了它。本 Task 将它接到现有的 IMAP 拉取 + xlsx 解析逻辑上，使 `--local-imports` 模式在真实环境中可运行。

**Files:**
- Modify: `skills/workflows/机型周数据/pipeline.py`
- Modify: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Write failing integration test**

Append to `scripts/tests/test_online_local_pipeline.py`:

```python
def test_load_local_source_frames_returns_six_dataframes(monkeypatch, tmp_path: Path):
    """Verify load_local_source_frames wires to the real mail fetcher and returns 6 keyed frames."""
    import email
    from email.mime.multipart import MIMEMultipart
    from email.mime.application import MIMEApplication
    import zipfile, io

    # Build a fake zip containing one xlsx per source
    fake_mails = {}
    for source in mail_sources.required_sources():
        buf = io.BytesIO()
        df = pd.DataFrame([{"统计周": "2026-W28", "成交量日均": 1.0}])
        df.to_excel(buf, index=False)
        buf.seek(0)

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as zf:
            zf.writestr(f"{source.source_key}.xlsx", buf.getvalue())
        zip_buf.seek(0)
        fake_mails[source.subject_contains] = zip_buf.getvalue()

    def fake_fetch_recent_zips(subjects, lookback_days=14):
        results = {}
        for subject, zip_bytes in fake_mails.items():
            results[subject] = {"zip_bytes": zip_bytes, "subject": subject, "date": "2026-07-07"}
        return results

    monkeypatch.setattr(pipeline, "_fetch_recent_zips_by_subject", fake_fetch_recent_zips)

    frames, metadata = pipeline.load_local_source_frames(lookback_days=14)

    assert set(frames.keys()) == {s.source_key for s in mail_sources.required_sources()}
    assert all(isinstance(df, pd.DataFrame) for df in frames.values())
    assert all(len(df) > 0 for df in frames.values())
    assert "mail_count" in metadata
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_load_local_source_frames_returns_six_dataframes -q
```

Expected:

```text
NotImplementedError: six-mail local source loader must be wired to the existing mailbox parser
```

- [ ] **Step 3: Implement the real loader**

Replace the `load_local_source_frames` stub in `skills/workflows/机型周数据/pipeline.py`:

```python
def _fetch_recent_zips_by_subject(subjects: list[str], lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> dict[str, dict]:
    """Fetch recent zip attachments from IMAP matching given subjects.

    Wraps the existing data_tools.email_reader.fetch_attachments() interface.
    Returns {subject_contains: {zip_bytes, subject, date}}.
    """
    from data_tools.email_reader import fetch_attachments

    results = fetch_attachments(
        subject_filters=subjects,
        lookback_days=lookback_days,
        attachment_type="zip",
    )
    return results


def _extract_dataframe_from_zip(zip_bytes: bytes, source_key: str) -> pd.DataFrame:
    """Extract the first xlsx/csv from a zip and return as DataFrame."""
    import zipfile, io

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        xlsx_names = [n for n in names if n.endswith(".xlsx")]
        csv_names = [n for n in names if n.endswith(".csv")]
        target = xlsx_names[0] if xlsx_names else csv_names[0] if csv_names else names[0]

        with zf.open(target) as f:
            data = f.read()

        if target.endswith(".xlsx"):
            return pd.read_excel(io.BytesIO(data))
        else:
            return pd.read_csv(io.BytesIO(data))


def load_local_source_frames(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> tuple[dict[str, pd.DataFrame], dict[str, Any]]:
    """Load six online mail sources into prepared DataFrames.

    Connects to IMAP, fetches recent zips matching the six mail subject patterns,
    extracts xlsx/csv, and returns keyed DataFrames ready for local CSV sink.
    """
    sources = required_sources()
    subjects = [s.subject_contains for s in sources]

    raw = _fetch_recent_zips_by_subject(subjects, lookback_days=lookback_days)

    # Map subject_contains back to source_key
    subject_to_source = {s.subject_contains: s for s in sources}
    frames: dict[str, pd.DataFrame] = {}
    for subject_contains, mail_data in raw.items():
        source = subject_to_source.get(subject_contains)
        if source is None:
            continue
        df = _extract_dataframe_from_zip(mail_data["zip_bytes"], source.source_key)
        frames[source.source_key] = df

    metadata = {
        "mail_count": len(raw),
        "fetched_subjects": list(raw.keys()),
    }
    return frames, metadata
```

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m pytest scripts/tests/test_local_imports.py scripts/tests/test_online_local_pipeline.py -q
```

Expected:

```text
5 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/pipeline.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): wire load_local_source_frames to IMAP parser"
```

---


### Task 3.5: Wire six-mail loader to existing IMAP + xlsx parser

**Files:**
- Modify: `skills/workflows/机型周数据/pipeline.py`
- Modify: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Add failing test that real loader can read six source ZIPs**

Append to `scripts/tests/test_online_local_pipeline.py`:

```python
import zipfile

import pytest


def _write_xlsx_zip(tmp_path: Path, source_key: str, rows: list[dict]) -> Path:
    xlsx_path = tmp_path / f"{source_key}.xlsx"
    zip_path = tmp_path / f"{source_key}.zip"
    pd.DataFrame(rows).to_excel(xlsx_path, index=False)
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.write(xlsx_path, arcname=f"{source_key}.xlsx")
    return zip_path


def test_load_local_source_frames_reads_all_six_zips(monkeypatch, tmp_path: Path):
    zip_map = {}
    for source_key in [
        "category_daily_avg",
        "model_summary",
        "category_summary",
        "model_daily_avg",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]:
        zip_map[source_key] = [
            _write_xlsx_zip(
                tmp_path,
                source_key,
                [{"日期": "2026-07-01", "统计周": "2026-W27", "成交量": 1}],
            )
        ]

    monkeypatch.setattr(
        pipeline,
        "fetch_recent_zips_by_subject",
        lambda lookback_days: (zip_map, {"mail_count": 6}),
    )

    frames, metadata = pipeline.load_local_source_frames(lookback_days=14)

    assert sorted(frames) == sorted(zip_map)
    assert metadata["mail_count"] == 6
    assert frames["model_daily_avg"].iloc[0]["统计周"] == "2026-W27"


def test_load_local_source_frames_fails_when_source_has_no_xlsx(monkeypatch, tmp_path: Path):
    empty_zip = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty_zip, "w"):
        pass
    monkeypatch.setattr(
        pipeline,
        "fetch_recent_zips_by_subject",
        lambda lookback_days: ({"model_daily_avg": [empty_zip]}, {"mail_count": 1}),
    )

    with pytest.raises(ValueError, match="no xlsx files"):
        pipeline.load_local_source_frames(lookback_days=14)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_load_local_source_frames_reads_all_six_zips scripts/tests/test_online_local_pipeline.py::test_load_local_source_frames_fails_when_source_has_no_xlsx -q
```

Expected:

```text
FAILED ... NotImplementedError: six-mail local source loader must be wired to the existing mailbox parser
```

- [ ] **Step 3: Implement subject-based fetch and xlsx loader**

Modify `skills/workflows/机型周数据/pipeline.py` by replacing the temporary `load_local_source_frames()` body and adding helpers:

```python
def fetch_recent_zips_by_subject(lookback_days: int = DEFAULT_LOOKBACK_DAYS) -> tuple[dict[str, list[Path]], dict[str, Any]]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    since = (date.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    zips_by_source: dict[str, list[Path]] = {}
    mail_metadata: dict[str, Any] = {"since": since, "sources": {}, "mail_count": 0}

    for source in required_sources():
        emails = list_emails(subject_contains=source.subject_contains, since=since, max_results=20)
        matched = [email for email in emails if source.subject_contains in email.subject and email.attachments]
        if not matched:
            continue
        # Keep all matching zips in the lookback window; downstream parser concatenates them.
        source_zips: list[Path] = []
        source_meta: list[dict[str, Any]] = []
        for email in matched:
            zip_name = next((a for a in email.attachments if a.lower().endswith(".zip")), None)
            if not zip_name:
                continue
            cache_key = CACHE_DIR / f"{source.source_key}_{email.uid}_{zip_name}"
            if not cache_key.exists():
                tmp = tempfile.mkdtemp(prefix=f"{source.source_key}_")
                try:
                    path_str = download_attachment(email.uid, zip_name, tmp)
                    shutil.move(path_str, cache_key)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
            source_zips.append(cache_key)
            source_meta.append({"uid": email.uid, "subject": email.subject, "date": email.date, "attachment": zip_name})
        if source_zips:
            zips_by_source[source.source_key] = sorted(set(source_zips))
            mail_metadata["sources"][source.source_key] = source_meta
            mail_metadata["mail_count"] += len(source_meta)

    return zips_by_source, mail_metadata


def _read_xlsx_frames_from_zip(zip_path: Path) -> list[pd.DataFrame]:
    frames: list[pd.DataFrame] = []
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
    zips_by_source, mail_metadata = fetch_recent_zips_by_subject(lookback_days=lookback_days)
    frames_by_source: dict[str, pd.DataFrame] = {}
    for source in required_sources():
        source_frames: list[pd.DataFrame] = []
        for zip_path in zips_by_source.get(source.source_key, []):
            source_frames.extend(_read_xlsx_frames_from_zip(zip_path))
        if source_frames:
            frames_by_source[source.source_key] = pd.concat(source_frames, ignore_index=True)
    return frames_by_source, mail_metadata
```

- [ ] **Step 4: Run local pipeline tests**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py -q
```

Expected:

```text
4 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/pipeline.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): wire local imports mail loader"
```

---

### Task 4: Add CLI switch and keep old Sheets/Base paths opt-in

**Files:**
- Modify: `skills/workflows/机型周数据/run.py`
- Test: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Add failing CLI parser test**

Append to `scripts/tests/test_online_local_pipeline.py`:

```python
run_mod = importlib.import_module("skills.workflows.机型周数据.run")


def test_run_main_local_imports_mode_calls_local_pipeline(monkeypatch, tmp_path: Path):
    calls = {}

    monkeypatch.setattr(run_mod, "_acquire_singleton_lock", lambda: open(__file__, "r", encoding="utf-8"))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "机型周数据",
            "--local-imports",
            "--months",
            "2026-07",
            "--local-output-dir",
            str(tmp_path),
            "--local-run-id",
            "20260707_093000",
            "--skip-notify",
        ],
    )

    def fake_local_pipeline(**kwargs):
        calls.update(kwargs)
        return {"status": "ok", "months": ["2026-07"], "by_month": {}}

    monkeypatch.setattr(run_mod, "run_local_imports_pipeline", fake_local_pipeline)

    assert run_mod.main() == 0
    assert calls["target_months"] == {"2026-07"}
    assert calls["output_root"] == tmp_path
    assert calls["run_id"] == "20260707_093000"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_run_main_local_imports_mode_calls_local_pipeline -q
```

Expected:

```text
SystemExit: 2
```

because `--local-imports` is not registered yet.

- [ ] **Step 3: Implement CLI**

Modify `skills/workflows/机型周数据/run.py` imports:

```python
from .pipeline import run_local_imports_pipeline, run_pipeline
```

Add CLI arguments after existing `--dry-run`:

```python
ap.add_argument("--local-imports", action="store_true", help="线上主链路: 写 data/imports CSV + manifest, 不写飞书明细")
ap.add_argument("--local-output-dir", type=str, default="data/imports", help="local imports 输出目录")
ap.add_argument("--local-run-id", type=str, default=None, help="local imports run_id; 默认当前时间")
ap.add_argument("--publish-base-index", action="store_true", help="local imports 后仅发布 Base 校验/索引记录; 不导入明细")
```

Add this branch before `if args.base_migration:`:

```python
if args.local_imports:
    result = run_local_imports_pipeline(
        target_months=months_set,
        lookback_days=args.lookback_days,
        output_root=Path(args.local_output_dir),
        run_id=args.local_run_id,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0 if result.get("status") == "ok" else 1
```

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py -q
```

Expected:

```text
2 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/run.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): expose local imports cli mode"
```

---

### Task 5: Add light Base validation index publisher

**Files:**
- Create: `skills/workflows/机型周数据/base_validation_publish.py`
- Modify: `skills/workflows/机型周数据/run.py`
- Test: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Add failing pure test for index rows**

Append to `scripts/tests/test_online_local_pipeline.py`:

```python
base_validation_publish = importlib.import_module("skills.workflows.机型周数据.base_validation_publish")


def test_build_validation_index_rows_are_small_and_manifest_based(tmp_path: Path):
    manifest = {
        "schema_version": 1,
        "run_id": "20260707_093000",
        "month": "2026-07",
        "outputs": {
            "model_daily_avg": {
                "path": str(tmp_path / "model_daily_avg_2026-07.csv"),
                "row_count": 2,
                "column_count": 3,
                "sha256": "a" * 64,
                "metric_sums": {"成交量日均": 4.0},
                "role": "primary",
            }
        },
        "validation_status": "pass",
    }

    fields, rows = base_validation_publish.build_validation_index_rows(manifest)

    assert "run_id" in fields
    assert "source_key" in fields
    assert "active" in fields
    row = dict(zip(fields, rows[0]))
    assert row["run_id"] == "20260707_093000"
    assert row["source_key"] == "model_daily_avg"
    assert row["row_count"] == 2
    assert row["active"] is True
    assert "成交量日均" in row["metric_sums_json"]
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_build_validation_index_rows_are_small_and_manifest_based -q
```

Expected:

```text
ModuleNotFoundError: No module named 'skills.workflows.机型周数据.base_validation_publish'
```

- [ ] **Step 3: Implement pure row builder**

Create `skills/workflows/机型周数据/base_validation_publish.py`:

```python
"""Publish lightweight Base validation records for local CSV imports."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


VALIDATION_INDEX_FIELDS = [
    "记录键",
    "run_id",
    "数据月份",
    "source_key",
    "role",
    "active",
    "状态",
    "文件路径",
    "row_count",
    "column_count",
    "sha256",
    "metric_sums_json",
]


def build_validation_index_rows(manifest: dict[str, Any], active: bool = True) -> tuple[list[str], list[list[Any]]]:
    rows: list[list[Any]] = []
    run_id = str(manifest["run_id"])
    month = str(manifest["month"])
    status = "已发布" if manifest.get("validation_status") == "pass" else "校验失败"
    for source_key, output in sorted(manifest.get("outputs", {}).items()):
        rows.append(
            [
                f"{month}|{source_key}|{run_id}",
                run_id,
                month,
                source_key,
                output.get("role", ""),
                active,
                status,
                output.get("path", ""),
                int(output.get("row_count", 0)),
                int(output.get("column_count", 0)),
                output.get("sha256", ""),
                json.dumps(output.get("metric_sums", {}), ensure_ascii=False, sort_keys=True),
            ]
        )
    return VALIDATION_INDEX_FIELDS, rows


def load_manifest(path: Path | str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))
```

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_build_validation_index_rows_are_small_and_manifest_based -q
```

Expected:

```text
1 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/base_validation_publish.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): add local import base validation rows"
```

---

### Task 6: Update notification text for split historical/online paths

**Files:**
- Modify: `skills/workflows/机型周数据/notifier.py`
- Test: `scripts/tests/test_online_local_pipeline.py`

- [ ] **Step 1: Add failing formatter test**

Append to `scripts/tests/test_online_local_pipeline.py`:

```python
notifier = importlib.import_module("skills.workflows.机型周数据.notifier")


def test_format_local_imports_notification_mentions_server_files_and_sheets_rollback():
    result = {
        "status": "ok",
        "run_id": "20260707_093000",
        "months": ["2026-07"],
        "by_month": {
            "2026-07": {
                "manifest_path": "data/imports/manifests/20260707_093000.json",
                "active_path": "data/imports/active.json",
                "outputs": {
                    "model_daily_avg": {"row_count": 10, "path": "data/imports/model_daily_avg_2026-07.csv"},
                },
            }
        },
    }

    title, lines = notifier.format_local_imports_notification(result)

    assert "本地 CSV" in title
    assert any("data/imports/active.json" in line for line in lines)
    assert any("旧 Sheets 回滚" in line for line in lines)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_format_local_imports_notification_mentions_server_files_and_sheets_rollback -q
```

Expected:

```text
AttributeError: module 'skills.workflows.机型周数据.notifier' has no attribute 'format_local_imports_notification'
```

- [ ] **Step 3: Implement formatter**

Add to `skills/workflows/机型周数据/notifier.py`:

```python
def format_local_imports_notification(result: dict) -> tuple[str, list[str]]:
    title = f"机型/品类周数据本地 CSV 发布: {result.get('status')}"
    lines = [f"run_id: {result.get('run_id')}", f"月份: {', '.join(result.get('months', []))}"]
    for month, month_result in sorted(result.get("by_month", {}).items()):
        lines.append(f"{month} manifest: {month_result.get('manifest_path')}")
        lines.append(f"{month} active: {month_result.get('active_path')}")
        for source_key, output in sorted(month_result.get("outputs", {}).items()):
            lines.append(f"{source_key}: rows={output.get('row_count')} path={output.get('path')}")
    lines.append("旧 Sheets 回滚: 保留原 Sheets 链路，未删除未覆盖。")
    lines.append("飞书 Base: 仅作为校验/发布索引，不承载每日全量明细。")
    return title, lines
```

- [ ] **Step 4: Run tests**

Run:

```bash
python3 -m pytest scripts/tests/test_online_local_pipeline.py::test_format_local_imports_notification_mentions_server_files_and_sheets_rollback -q
```

Expected:

```text
1 passed
```

- [ ] **Step 5: Commit**

```bash
git add skills/workflows/机型周数据/notifier.py scripts/tests/test_online_local_pipeline.py
git commit -m "feat(skills): format local imports notifications"
```

---

### Task 7: Cron switch plan

**Files:**
- Create or Modify: `scripts/机型周数据_cron.sh`
- Test: shell dry-run by command inspection

- [ ] **Step 1: Inspect current cron script**

Run:

```bash
sed -n '1,220p' scripts/机型周数据_cron.sh
```

Expected:

- If the file exists, it must call `python3 -m skills.workflows.机型周数据`.
- If it does not exist, create it in Step 2.

- [ ] **Step 2: Make local CSV mode the cron default**

Set cron command to:

```bash
python3 -m skills.workflows.机型周数据 \
  --local-imports \
  --lookback-days "${LOOKBACK_DAYS:-14}" \
  --local-output-dir "${LOCAL_IMPORT_OUTPUT_DIR:-data/imports}"
```

Do not include `--base-import` in cron default. Keep historical Base imports as a manual command only.

- [ ] **Step 3: Verify cron script does not call Base import or old Sheets default path**

Run:

```bash
grep -n -- '--local-imports' scripts/机型周数据_cron.sh
! grep -nE -- '--base-import|--base-migration|--sheets|run_pipeline' scripts/机型周数据_cron.sh
```

Expected: both commands exit `0`; cron contains `--local-imports` and does not contain Base import, Base migration, Sheets mode, or direct `run_pipeline` invocation.

- [ ] **Step 4: Commit**

```bash
git add scripts/机型周数据_cron.sh
git commit -m "chore(skills): switch weekly cron to local imports"
```

---

## 4. Verification Plan

Before claiming this work is complete, run all commands below and read full output:

```bash
git status --short --branch
python3 -m pytest scripts/tests/test_base_migration.py scripts/tests/test_local_imports.py scripts/tests/test_online_local_pipeline.py -v
python3 -m compileall skills/workflows/机型周数据 scripts/import_weekly_base_partition_v1.py
python3 - <<'PY'
from pathlib import Path
bad=[]
for p in Path('.').rglob('*'):
    if '.git' in p.parts or not p.is_file():
        continue
    name=p.name.lower()
    if name.endswith(('.bak', '.log', '.csv', '.xlsx', '.zip')):
        bad.append(str(p))
print('\n'.join(bad))
raise SystemExit(1 if bad else 0)
PY
git diff --stat origin/main...HEAD
git log --oneline --decorate -8
```

Pass criteria:

- `git status` only shows intended source/docs/test/script files.
- No `.bak`、日志、真实数据快照、CSV、XLSX、ZIP 被纳入 git。
- Existing historical Base tests still pass.
- New local-imports tests pass.
- `compileall` exits 0.
- Commit messages follow Conventional Commits.

---

## 5. Operational Rules After Cutover

1. **Daily source of truth:** `data/imports/active.json` and the manifest it points to.
2. **Human validation:** Feishu Base validation/index records; no daily full-detail Base import.
3. **Rollback:** switch downstream active pointer to a prior manifest/CSV package; if human needs Base inspection, re-import that package manually.
4. **Big-market layer:** compute from category CSV sums; Feishu big-market Base remains a periodic benchmark only.
5. **History backfill:** continue using `scripts/import_weekly_base_partition_v1.py` with `base_partition_v1`; do not reuse daily cron for full historical imports.

---

## 6. Superpowers Completeness Self-Review

### 6.1 Spec coverage

| Requirement | Covered by |
|---|---|
| 6 封邮件固定契约，且说明 role 与 required 关系 | Task 1 |
| IMAP/解析/聚合保留，最终 sink 改本地 CSV | Task 3, Task 3.5 |
| `data/imports/*.csv` 输出 | Task 2 |
| manifest + active pointer，且 active 最后原子更新 | Task 2 |
| Base 仅校验/发布索引 | Task 5 |
| 大盘由品类求和，不做主链路飞书表 | Section 0, Section 5 |
| 历史回溯和线上流程拆开 | Section 0, Section 5 |
| Cron 不再默认 Base 明细导入或旧 Sheets 写入 | Task 7 |
| 旧 Sheets 保留回滚 | Task 6, Section 5 |

### 6.2 Placeholder scan

Checked for common placeholder red flags and none remain as implementation placeholders. The plan contains concrete file paths, code snippets, commands, and expected results for each task.

### 6.3 Type consistency

- `source_key` is consistently used as the stable ID across `mail_sources.py`、`local_imports.py`、manifest、Base validation rows.
- `month` is consistently `YYYY-MM`.
- `run_id` is consistently a string and flows into manifest, active pointer, and Base validation rows.
- `outputs` is consistently `dict[str, pandas.DataFrame]` before write and `dict[str, manifest metadata]` after write.

---

## 7. Execution Handoff

Recommended execution mode in Codex Desktop: **Inline Execution** with Superpowers `executing-plans`, because the current session does not expose a subagent tool. If a future session exposes subagents, switch to **Subagent-Driven** and dispatch one fresh worker per task.
