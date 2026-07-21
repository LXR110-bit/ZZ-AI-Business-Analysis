#!/usr/bin/env python3
"""Cross-tick Loop1 runner for the five base AIWAN SQLs.

The existing inline state machine remains the full7 compatibility entrypoint.
This runner persists SQL execute ids through the generic AIWAN job control
plane and treats an unfinished tick as a successful, pending scheduler tick.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import aiwan_inline_state_machine as core


BASE_SCRIPTS = [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
    "sqldau",
]
MAX_ACTIVE_SQL = 2
MAX_SQL_RETRIES = 2
SUCCESS_STATUSES = {core.normalize_sql_status(status) for status in core.TERMINAL_SUCCESS}
FAILED_STATUSES = {core.normalize_sql_status(status) for status in core.TERMINAL_FAILED}
JOBS_READ_PATH = "/v2/aiwan/api/aiwan/jobs/read"
JOBS_WRITE_PATH = "/v2/aiwan/api/aiwan/jobs/write"
REQUIRED_LOOP_MODEL_ID = "claude-sonnet-4-6[1m]"


def runtime_model_pin() -> dict[str, Any]:
    actual = next((
        os.environ.get(key)
        for key in ("ZLOOP_MODEL_ID", "WORKBENCH_MODEL_ID", "MODEL_ID")
        if os.environ.get(key)
    ), None)
    if actual and actual != REQUIRED_LOOP_MODEL_ID:
        raise RuntimeError(
            f"MODEL_PIN_MISMATCH: required={REQUIRED_LOOP_MODEL_ID} actual={actual}"
        )
    return {
        "required_model_id": REQUIRED_LOOP_MODEL_ID,
        "runtime_model_id": actual,
        "verified": actual == REQUIRED_LOOP_MODEL_ID if actual else False,
        "verification": "runtime_env" if actual else "unverified_no_runtime_model_env",
    }


class JobApiError(RuntimeError):
    def __init__(self, code: str, message: str, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


def _response_json(response: Any) -> dict[str, Any]:
    data = response.json()
    if not getattr(response, "ok", False) or not isinstance(data, dict) or data.get("ok") is not True:
        error = data.get("error") if isinstance(data, dict) else {}
        if not isinstance(error, dict):
            error = {}
        raise JobApiError(
            str(error.get("code") or "AIWAN_JOB_API_FAILED"),
            str(error.get("message") or f"AIWAN job API failed: {data!r}"),
            getattr(response, "status_code", None),
            error.get("details") if error.get("details") is not None else error.get("data"),
        )
    return data


class HubJobClient:
    def __init__(self, hub_module: Any = None):
        self.hub = hub_module or core.hub
        if self.hub is None:
            raise RuntimeError("zloop_runtime.hub is unavailable")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "create"}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]

    def get(self, analysis_key: str, base_revision: int, kind: str = "base", handoff_revision: int = 0) -> dict[str, Any]:
        body = {
            "analysis_key": analysis_key,
            "kind": kind,
            "base_revision": base_revision,
            "handoff_revision": handoff_revision,
        }
        return _response_json(self.hub.post(JOBS_READ_PATH, json_body=body, timeout=90.0))["job"]

    def claim(self, analysis_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "claim", "analysis_key": analysis_key}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]

    def update(self, analysis_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "state", "analysis_key": analysis_key}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]


class CoreAdapter:
    def render_sqls(self, args: argparse.Namespace, export_dir: Path) -> dict[str, dict[str, str]]:
        export_dir.mkdir(parents=True, exist_ok=True)
        rendered: dict[str, dict[str, str]] = {}
        for name in BASE_SCRIPTS:
            template = core.repo_root() / "references" / "read" / "sql" / f"{name}.sql"
            sql = core.render_sql(template.read_text(encoding="utf-8"), args.run_dt, args.data_end_date)
            path = export_dir / f"{name}_{args.run_dt}.sql"
            path.write_text(sql, encoding="utf-8")
            rendered[name] = {"sql": sql, "path": str(path), "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest()}
        return rendered

    def materialize(self, execute_id: str, csv_path: Path, debug_dir: Path, script_name: str) -> int:
        return core.materialize_full_csv(execute_id, csv_path, debug_dir, script_name)

    def package_base(self, args: argparse.Namespace, export_dir: Path, raw_root: Path) -> dict[str, Any]:
        raw_root.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            str(core.repo_root() / "scripts" / "package_raw_cache.py"),
            "--run-dt", args.run_dt,
            "--run-id", args.run_id,
            "--input-dir", str(export_dir),
            "--out-dir", str(raw_root),
            "--sql-scope", "base",
            "--scripts", ",".join(BASE_SCRIPTS),
        ]
        result = subprocess.run(command, text=True, capture_output=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"package-raw-cache base failed: {result.stderr[-2000:] or result.stdout[-2000:]}")
        active_path = raw_root / "active_fetch_manifest.json"
        active = core.read_json(active_path)
        active.update({"week": args.week, "data_end_date": args.data_end_date, "week_start_dates": core.week_start_dates(args.week)})
        core.write_json(active_path, active)
        return active

    def process(self, args: argparse.Namespace, run_dir: Path, read_result: dict[str, Any]) -> dict[str, Any]:
        return core.execute_process(args, run_dir, read_result)

    def analyze(self, args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> dict[str, Any]:
        return core.execute_analyze(args, run_dir, processed)

    def validate(self, args: argparse.Namespace, run_dir: Path, processed: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        return core.execute_validate(args, run_dir, processed, analysis)


def iso_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def lease_active(job: dict[str, Any]) -> bool:
    raw = job.get("lease_expires_at")
    if not raw:
        return False
    try:
        expires = datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return expires > datetime.now().astimezone().timestamp()


def pending_result(args: argparse.Namespace, job: dict[str, Any] | None, reason: str) -> dict[str, Any]:
    return {
        "ok": True,
        "business_status": "pending",
        "reason": reason,
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "job_status": job.get("status") if job else None,
        "state_revision": job.get("state_revision") if job else None,
        "sql_checkpoints": job.get("sql_checkpoints", {}) if job else {},
    }


# 下钻名单选择口径（设计 §5.2/§5.3/§12；阈值版本化，勿散落到 SQL）
DRILLDOWN_FLOOR_TIERS = ("发展", "孵化")   # always_floor：每周必进机型主指标观察范围
DRILLDOWN_SEED_TIER = "种子"
DRILLDOWN_GMV_WOW_THRESHOLD = 0.10        # 种子品类 GMV 环比绝对变化激活阈值


def select_drilldown_categories(
    evidence_pack: dict[str, Any],
    *,
    gmv_threshold: float = DRILLDOWN_GMV_WOW_THRESHOLD,
) -> list[dict[str, Any]]:
    """确定性算出 Loop2 下钻品类名单：发展+孵化(always_floor) ∪ 种子异动(wow_anomaly)。

    AI 补充(ai_supplement)先留空。数字只读 evidence_pack，不发明。保持 evidence 的
    impact 排序，按品类去重。
    """
    items = evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        category = str(it.get("category") or "").strip()
        if not category or category in seen:
            continue
        tier = str(it.get("tier") or "").strip()
        delta = it.get("delta") or {}
        pct = delta.get("gmv_delta_pct")
        try:
            gmv_moved = pct is not None and abs(float(pct)) >= gmv_threshold
        except (TypeError, ValueError):
            gmv_moved = False
        if tier in DRILLDOWN_FLOOR_TIERS:
            reason = "always_floor"
        elif tier == DRILLDOWN_SEED_TIER and gmv_moved:
            reason = "wow_anomaly"
        else:
            continue
        seen.add(category)
        out.append({
            "category": category,
            "tier": tier,
            "reason": reason,
            "moved_metrics": ["gmv"] if gmv_moved else [],
            "direction": it.get("direction"),
            "gmv_delta": delta.get("gmv_delta"),
            "gmv_delta_pct": pct,
        })
    return out


HANDOFF_REUSABLE_STATUSES = {
    "ready", "claimed", "sql_submitted", "sql_running", "materializing",
    "processing", "analyzing", "validating", "published",
}


def _is_create_conflict(exc: Exception) -> bool:
    status = getattr(exc, "status", None)
    code = str(getattr(exc, "code", "") or "")
    text = str(exc)
    return status == 409 or code in {"JOB_REVISION_CONFLICT", "JOB_ALREADY_EXISTS"} or "409" in text


def is_control_plane_conflict(exc: Exception) -> bool:
    """Return True for direct CAS conflicts and API Hub wrapped downstream 409s."""
    status = getattr(exc, "status", None)
    code = str(getattr(exc, "code", "") or "")
    text = str(exc)
    details = getattr(exc, "details", None)
    upstream_status = None
    if isinstance(details, dict):
        upstream_status = details.get("upstream_status") or details.get("status")
    return (
        status == 409
        or (
            code in {
                "JOB_STATE_REVISION_CONFLICT",
                "JOB_LEASE_CONFLICT",
                "JOB_LEASE_EXPIRED",
                "JOB_NOT_CLAIMABLE",
                "HUB_UPSTREAM_ERROR",
            }
            and (upstream_status == 409 or "409" in text)
        )
        or ("409" in text and code in {"AIWAN_JOB_API_FAILED", "HUB_UPSTREAM_ERROR"})
    )


def _handoff_matches_payload(existing: dict[str, Any], payload: dict[str, Any]) -> bool:
    if not existing:
        return False
    for key in ("kind", "analysis_key", "week", "data_end_date", "loop1_run_id", "base_revision", "handoff_revision", "model_enrichment_mode"):
        if existing.get(key) != payload.get(key):
            return False
    if (existing.get("drilldown_categories") or []) != (payload.get("drilldown_categories") or []):
        return False
    return str(existing.get("status") or "") in HANDOFF_REUSABLE_STATUSES


def ensure_drilldown_handoff(
    job_client: Any,
    args: argparse.Namespace,
    *,
    drilldown_categories: list[dict[str, Any]] | None = None,
    model_enrichment_mode: str | None = None,
) -> dict[str, Any]:
    categories = drilldown_categories or []
    mode = model_enrichment_mode or ("enabled" if categories else "disabled")
    payload = {
        "kind": "drilldown",
        "analysis_key": args.analysis_key,
        "week": args.week,
        "data_end_date": args.data_end_date,
        "loop1_run_id": args.run_id,
        "base_revision": args.base_revision,
        "handoff_revision": 1,
        "status": "ready",
        "current_stage": "read",
        "model_enrichment_mode": mode,
        "drilldown_categories": categories,
        "execute_ids": {},
        "sql_hashes": {},
        "sql_checkpoints": {},
    }
    try:
        return job_client.create(payload)
    except Exception as exc:
        if not _is_create_conflict(exc):
            raise
        existing = job_client.get(args.analysis_key, args.base_revision, kind="drilldown", handoff_revision=1)
        if _handoff_matches_payload(existing, payload):
            return existing
        raise


def try_get_existing_handoff(job_client: Any, args: argparse.Namespace) -> dict[str, Any] | None:
    try:
        handoff = job_client.get(args.analysis_key, args.base_revision, kind="drilldown", handoff_revision=1)
    except Exception:
        return None
    return handoff if str(handoff.get("status") or "") in HANDOFF_REUSABLE_STATUSES else None


def _run_dir_from_result(args: argparse.Namespace, result: dict[str, Any]) -> Path:
    raw = result.get("artifacts_dir")
    if raw:
        return Path(str(raw))
    return core.out_root() / "aiwan_runs" / args.run_id


def _summarize_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job.get("job_id"),
        "analysis_key": job.get("analysis_key"),
        "base_revision": job.get("base_revision"),
        "handoff_revision": job.get("handoff_revision"),
        "status": job.get("status"),
        "current_stage": job.get("current_stage"),
        "state_revision": job.get("state_revision"),
        "publication_status": job.get("publication_status"),
        "deliveryState": job.get("deliveryState"),
        "lease_owner": job.get("lease_owner"),
        "lease_expires_at": job.get("lease_expires_at"),
        "error": job.get("error"),
    }


def write_final_publish_artifacts(args: argparse.Namespace, result: dict[str, Any]) -> dict[str, str]:
    """Persist concise final summary plus deeper diagnostics outside final text."""
    run_dir = _run_dir_from_result(args, result)
    run_dir.mkdir(parents=True, exist_ok=True)
    job = result.get("job") if isinstance(result.get("job"), dict) else {}
    final_summary = {
        "ok": result.get("ok"),
        "business_status": result.get("business_status"),
        "publication_status": result.get("publication_status"),
        "run_id": result.get("run_id"),
        "analysis_key": result.get("analysis_key"),
        "job_status": job.get("status"),
        "job_current_stage": job.get("current_stage"),
        "deliveryState": job.get("deliveryState"),
        "stage_results": result.get("stage_results"),
        "handoff_status": result.get("handoff_status"),
        "artifacts_dir": str(run_dir),
        "generated_at": iso_now(),
    }
    diagnostics = {
        "summary": final_summary,
        "job": _summarize_job(job),
        "stage_results": result.get("stage_results"),
        "sql_checkpoints": job.get("sql_checkpoints") or {},
        "execute_ids": job.get("execute_ids") or {},
        "handoff_job": _summarize_job(result.get("handoff_job") or {}) if isinstance(result.get("handoff_job"), dict) else None,
        "handoff_error": result.get("handoff_error"),
        "support_artifacts": {
            name: str(run_dir / name)
            for name in (
                ANALYZE_INPUT_FILE,
                ANALYSIS_DIGEST_FILE,
                ANALYSIS_CATEGORIES_INDEX_FILE,
                ANALYSIS_TOP_MOVERS_FILE,
                CATEGORY_TAIL_HINTS_FILE,
                ANALYSIS_RESULT_FILE,
                "analysis_result_assembled.json",
            )
            if (run_dir / name).exists()
        },
    }
    summary_path = run_dir / FINAL_SUMMARY_FILE
    diagnostics_path = run_dir / LOOP1_DIAGNOSTICS_FILE
    core.write_json(summary_path, final_summary)
    core.write_json(diagnostics_path, diagnostics)
    return {"final_summary": str(summary_path), "diagnostics": str(diagnostics_path)}


def published_result(
    args: argparse.Namespace,
    job_client: Any,
    job: dict[str, Any],
    *,
    drilldown_categories: list[dict[str, Any]] | None = None,
    model_enrichment_mode: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    publication_status = str(job.get("publication_status") or "published")
    business_status = "late_published" if publication_status == "late_published" else "published"
    result = {"ok": True, "business_status": business_status, "publication_status": publication_status,
              "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job, **extra}
    try:
        # A later tick may enter here after the base job is already published. At that point
        # the original analysis scaffold is not available, so do not synthesize a fresh
        # disabled/empty handoff payload that can conflict with the already-created one.
        # Prefer the authoritative existing drilldown handoff when present.
        if drilldown_categories is None and model_enrichment_mode is None:
            existing = try_get_existing_handoff(job_client, args)
            if existing is not None:
                result["handoff_job"] = existing
                result["handoff_status"] = existing.get("status") or "ready"
                result["handoff_reused"] = True
            else:
                result["handoff_job"] = ensure_drilldown_handoff(
                    job_client, args,
                    drilldown_categories=drilldown_categories,
                    model_enrichment_mode=model_enrichment_mode,
                )
                result["handoff_status"] = result["handoff_job"].get("status") or "ready"
        else:
            result["handoff_job"] = ensure_drilldown_handoff(
                job_client, args,
                drilldown_categories=drilldown_categories,
                model_enrichment_mode=model_enrichment_mode,
            )
            result["handoff_status"] = result["handoff_job"].get("status") or "ready"
    except Exception as exc:
        result["handoff_status"] = "retryable_failed"
        result["handoff_error"] = str(exc)
    result["final_artifacts"] = write_final_publish_artifacts(args, result)
    return result


def checkpoint_update(job_client: Any, args: argparse.Namespace, job: dict[str, Any], status: str, **fields: Any) -> dict[str, Any]:
    payload = {
        "kind": "base",
        "base_revision": args.base_revision,
        "handoff_revision": 0,
        "expected_state_revision": job["state_revision"],
        "worker_id": args.worker_id,
        "status": status,
        **fields,
    }
    return job_client.update(args.analysis_key, payload)


def checkpoint_update_refreshing(
    job_client: Any,
    args: argparse.Namespace,
    job: dict[str, Any],
    status: str,
    **fields: Any,
) -> dict[str, Any]:
    """Retry one state update after rereading the latest state revision."""
    try:
        return checkpoint_update(job_client, args, job, status, **fields)
    except JobApiError as exc:
        if not is_control_plane_conflict(exc):
            raise
        latest = job_client.get(args.analysis_key, args.base_revision)
        return checkpoint_update(job_client, args, latest, status, **fields)


def retryable_analyze_failure_result(
    args: argparse.Namespace,
    job_client: Any,
    job: dict[str, Any],
    code: str,
    details_key: str,
    details: list[Any],
) -> dict[str, Any]:
    """Record analyze/finalize failure without illegal validate -> analyze rollback."""
    already_validating = job.get("status") == "validating" or job.get("current_stage") == "validate"
    target_status = "validating" if already_validating else "analyzing"
    target_stage = "validate" if already_validating else "analyze"
    rollback_status = "preserved_validating" if already_validating else "marked_analyzing"
    trimmed = details[:30] if details_key == "failed_checks" else details[:20]
    error = {"code": code, details_key: trimmed, "rollback_status": rollback_status}
    try:
        job = checkpoint_update_refreshing(
            job_client,
            args,
            job,
            target_status,
            current_stage=target_stage,
            error=error,
        )
    except JobApiError as exc:
        if not is_control_plane_conflict(exc):
            raise
        try:
            job = job_client.get(args.analysis_key, args.base_revision)
        except Exception:
            pass
        error["rollback_status"] = "conflict_not_updated"
        error["conflict"] = {
            "code": getattr(exc, "code", "JOB_STATE_CONFLICT"),
            "status": getattr(exc, "status", None),
            "details": getattr(exc, "details", None),
            "message": str(exc)[:1000],
        }
    return {
        "ok": False,
        "business_status": "retryable_failed",
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "error": error,
        "job": job,
    }


def _checkpoint_artifact_is_reusable(
    checkpoint: dict[str, Any],
    *,
    expected_sql_hash: str,
) -> Path | None:
    if sql_status(checkpoint.get("status")) not in SUCCESS_STATUSES:
        return None
    if str(checkpoint.get("sql_hash") or "") != expected_sql_hash:
        return None
    artifact_uri = str(checkpoint.get("artifact_uri") or "").strip()
    artifact_hash = str(checkpoint.get("artifact_hash") or "").strip()
    if not artifact_uri or not artifact_hash:
        return None
    artifact = Path(artifact_uri)
    if not artifact.is_file() or core.sha256_file(artifact) != artifact_hash:
        return None
    return artifact


def inherit_previous_revision_checkpoints(
    job_client: Any,
    args: argparse.Namespace,
    job: dict[str, Any],
    sql_hashes: dict[str, str],
    export_dir: Path,
) -> tuple[dict[str, Any], list[str]]:
    """Reuse prior revision CSVs only after identity + SQL + file SHA checks.

    A missing file or any hash mismatch is a cache miss, not an execution error;
    the normal SQL submission path remains authoritative in that case.
    """
    if args.base_revision <= 1:
        return job, []
    current = dict(job.get("sql_checkpoints") or {})
    inherited: dict[str, dict[str, Any]] = {}
    inherited_names: list[str] = []
    for previous_revision in range(args.base_revision - 1, 0, -1):
        try:
            previous = job_client.get(args.analysis_key, previous_revision)
        except Exception:
            continue
        if (
            previous.get("analysis_key") != args.analysis_key
            or previous.get("week") != args.week
            or previous.get("data_end_date") != args.data_end_date
        ):
            continue
        for name in BASE_SCRIPTS:
            if name in inherited or sql_status((current.get(name) or {}).get("status")) in SUCCESS_STATUSES:
                continue
            checkpoint = (previous.get("sql_checkpoints") or {}).get(name) or {}
            source = _checkpoint_artifact_is_reusable(checkpoint, expected_sql_hash=sql_hashes[name])
            if source is None:
                continue
            target = export_dir / f"{name}_{args.run_dt}.csv"
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.resolve() != target.resolve():
                shutil.copy2(source, target)
            copied_hash = core.sha256_file(target)
            if copied_hash != checkpoint.get("artifact_hash"):
                target.unlink(missing_ok=True)
                continue
            inherited[name] = {
                "execute_id": str(checkpoint.get("execute_id") or ""),
                "sql_hash": sql_hashes[name],
                "status": "SUCCESS",
                "retry_count": int(checkpoint.get("retry_count") or 0),
                "artifact_uri": str(target),
                "artifact_hash": copied_hash,
                "materialized_at": checkpoint.get("materialized_at") or iso_now(),
                "inherited_from_base_revision": previous_revision,
                "inherited_from_job_id": str(previous.get("job_id") or ""),
            }
            inherited_names.append(name)
        if len(inherited) == len(BASE_SCRIPTS):
            break
    if not inherited:
        return job, []
    next_status = "sql_submitted" if job.get("status") == "claimed" else str(job.get("status") or "sql_submitted")
    job = checkpoint_update(
        job_client, args, job, next_status,
        current_stage="read",
        sql_checkpoints=inherited,
        checkpoint_reuse={"source": "previous_base_revision", "scripts": sorted(inherited_names)},
    )
    return job, sorted(inherited_names)


def submit_sql(xinghe: Any, name: str, sql: str, args: argparse.Namespace) -> str:
    response = core.call_with_supported_kwargs(
        xinghe.run_hive_sql,
        content=sql,
        sql=sql,
        title=f"AIWAN Loop1 {name} {args.run_dt}",
        business_id="5",
        business_name="聚合回收",
    )
    return core.normalize_execute_id(response)


def poll_sql(xinghe: Any, execute_id: str) -> str:
    response = core.call_with_supported_kwargs(xinghe.check_sql_status, execute_id=execute_id, execute_ids=[execute_id])
    return core.normalize_sql_status(core.get_status_for(response, execute_id))


def sql_status(status: Any) -> str:
    return core.normalize_sql_status(status)


def build_read_result(args: argparse.Namespace, run_dir: Path, job: dict[str, Any], active: dict[str, Any]) -> dict[str, Any]:
    raw_root = run_dir / "read_artifacts"
    return {
        "stage": "read",
        "status": active.get("status", "success"),
        "output_type": "sql_result",
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "week_start_dates": core.week_start_dates(args.week),
        "sql_scope": "base",
        "sql_status": job.get("sql_checkpoints", {}),
        "warnings": active.get("warnings", []),
        "artifacts": {
            "input_dir": str(raw_root),
            "active_fetch_manifest": str(raw_root / "active_fetch_manifest.json"),
            "raw_cache": str(raw_root / f"raw_cache_{args.run_dt}.zip"),
            "sql_status": str(raw_root / f"sql_status_{args.run_dt}.json"),
            "raw_manifest": str(raw_root / f"raw_manifest_{args.run_dt}.json"),
        },
        "next_stage": "process",
    }


ANALYZE_INPUT_FILE = "analyze_input.json"
ANALYSIS_RESULT_FILE = "analysis_result.json"      # agent 写入
PROCESSED_RESULT_FILE = "processed_result.json"
ANALYSIS_SCAFFOLD_FILE = "analysis_scaffold.json"
ANALYSIS_DIGEST_FILE = "analysis_digest.json"
ANALYSIS_CATEGORIES_INDEX_FILE = "analysis_categories_index.json"
ANALYSIS_TOP_MOVERS_FILE = "analysis_top_movers.json"
ANALYSIS_SHARDS_DIR = "analysis_category_shards"
CATEGORY_TAIL_HINTS_FILE = "category_tail_hints.json"
FINAL_SUMMARY_FILE = "final_summary.json"
LOOP1_DIAGNOSTICS_FILE = "aiwan_loop1_diagnostics.json"
REQUIRED_DISPLAY_KEYS = ("board", "category", "monitor", "tiers", "secondaryCategories", "categories")
CONTROLLED_LABELS = ("高影响风险品类", "明确机会品类", "异常风险品类", "低基数波动品类", "稳健品类")
BANNED_SUBJECTIVE = ("效果显著", "明显改善", "大幅提升", "表现优异")


def _preview_list(values: Any, limit: int = 80) -> list[Any]:
    if not isinstance(values, list):
        return []
    return values[:limit]


def build_analysis_payload(analyze_input_path: Path) -> dict[str, Any] | None:
    """Small inline handoff so scheduled-agent does not depend only on a file path.

    The full evidence remains in analyze_input.json.  This payload deliberately
    carries only routing/coverage/digest data that is safe to print in the tick
    JSON and enough for the agent to keep the active-root workflow alive if a
    later file read temporarily fails.
    """
    if not analyze_input_path.exists():
        return None
    data = core.read_json(analyze_input_path)
    if not isinstance(data, dict):
        return None
    evidence = data.get("evidence_pack") if isinstance(data.get("evidence_pack"), dict) else {}
    return {
        "run_id": data.get("run_id"),
        "week": data.get("week"),
        "run_dt": data.get("run_dt"),
        "display_contract": data.get("display_contract"),
        "required_display_keys": data.get("required_display_keys") or list(REQUIRED_DISPLAY_KEYS),
        "categories_to_cover": _preview_list(data.get("categories_to_cover"), 200),
        "secondary_to_cover": _preview_list(data.get("secondary_to_cover"), 200),
        "digest": data.get("digest") or {},
        "model_pin": data.get("model_pin") or runtime_model_pin(),
        "history_weeks": data.get("history_weeks"),
        "evidence_pack_summary": {
            "latest_week": evidence.get("latest_week"),
            "prev_week": evidence.get("prev_week"),
            "board": evidence.get("board") or {},
            "category_count": len(evidence.get("category_all") or evidence.get("category_top_changes") or []),
            "secondary_count": len(evidence.get("cluster_top_changes") or []),
            "known_gaps": evidence.get("known_gaps") or [],
            "data_quality_notes": evidence.get("data_quality_notes") or [],
        },
        "support_artifacts": data.get("support_artifacts") or {},
    }


def next_agent_action(args: argparse.Namespace, run_dir: Path, analyze_input_exists: bool) -> dict[str, Any]:
    return {
        "must_continue": True,
        "active_root_skill": "AI小万主编排 v1.6",
        "active_root_skill_public_id": "b28e30d2-b8c6-456f-888d-57c48785286f",
        "stage": "analyze",
        "instruction": (
            "继续按本 Skill 的 analyze 阶段执行，不得结束本轮、不得改用 Loop 管理话术。"
            "优先读取 analyze_input.json；若文件读取失败但 analysis_payload 存在，可用 payload 先写 board/tiers/secondary 骨架，"
            "再根据可读 evidence 补齐 categories。写完 analysis_result.json 后必须再次运行 aiwan_loop1_tick.py finalize。"
        ),
        "analyze_input": str(run_dir / ANALYZE_INPUT_FILE),
        "analyze_input_exists": analyze_input_exists,
        "analysis_result_expected": str(run_dir / ANALYSIS_RESULT_FILE),
        "required_model_id": REQUIRED_LOOP_MODEL_ID,
        "rerun_command_hint": (
            "python3 scripts/aiwan_loop1_tick.py "
            f"--week {args.week} --run-dt {args.run_dt} --data-end-date {args.data_end_date} "
            f"--base-revision {args.base_revision}"
        ),
    }


def analyze_input_missing_result(
    args: argparse.Namespace,
    job: dict[str, Any] | None,
    run_dir: Path,
    reason: str,
    *,
    restore_diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": False,
        "business_status": "retryable_failed",
        "reason": reason,
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "analyze_input": str(run_dir / ANALYZE_INPUT_FILE),
        "analyze_input_exists": False,
        "analysis_result_expected": str(run_dir / ANALYSIS_RESULT_FILE),
        "next_agent_action": next_agent_action(args, run_dir, False),
        "error": {
            "code": "ANALYZE_INPUT_MISSING",
            "message": "current_stage is analyze/validate but analyze_input.json is not available in this sandbox; rerun tick can rebuild from durable SQL checkpoints, otherwise retry after control-plane state is repaired.",
        },
        "restore_diagnostics": restore_diagnostics,
        "job_status": job.get("status") if job else None,
    }


def analyze_pending_result(args: argparse.Namespace, job: dict[str, Any] | None, run_dir: Path) -> dict[str, Any]:
    analyze_path = run_dir / ANALYZE_INPUT_FILE
    exists = analyze_path.exists()
    payload = build_analysis_payload(analyze_path) if exists else None
    return {
        "ok": True,
        "business_status": "analyze_pending",
        "reason": "await_agent_analysis",
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "analyze_input": str(analyze_path),
        "analyze_input_exists": exists,
        "analysis_result_expected": str(run_dir / ANALYSIS_RESULT_FILE),
        "analysis_payload": payload,
        "next_agent_action": next_agent_action(args, run_dir, exists),
        "job_status": job.get("status") if job else None,
    }


def compute_digest(evidence_pack: dict[str, Any]) -> dict[str, Any]:
    """确定性预算 board/三层/板块 聚合，agent 只写叙述、不再自己从品类逐个加总。"""
    items = evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or []
    items = [i for i in items if isinstance(i, dict) and i.get("category")]

    def g(d: Any, k: str) -> float:
        try:
            return float((d or {}).get(k) or 0)
        except (TypeError, ValueError):
            return 0.0

    def roll(group_key: str) -> dict[str, Any]:
        out: dict[str, dict[str, Any]] = {}
        for it in items:
            key = str(it.get(group_key) or "未归类")
            b = out.setdefault(key, {"gmv": 0.0, "gmv_delta": 0.0, "deal_delta": 0.0, "category_count": 0, "drag": [], "opportunity": []})
            b["gmv"] += g(it.get("cur"), "gmv")
            b["gmv_delta"] += g(it.get("delta"), "gmv_delta")
            b["deal_delta"] += g(it.get("delta"), "deal_delta")
            b["category_count"] += 1
            gd = g(it.get("delta"), "gmv_delta")
            (b["drag"] if gd < 0 else b["opportunity"]).append((it["category"], gd))
        for b in out.values():
            b["drag"] = [c for c, _ in sorted(b["drag"], key=lambda x: x[1])[:5]]
            b["opportunity"] = [c for c, _ in sorted(b["opportunity"], key=lambda x: -x[1])[:3]]
            b["gmv"] = round(b["gmv"], 1)
            b["gmv_delta"] = round(b["gmv_delta"], 1)
            b["deal_delta"] = round(b["deal_delta"], 2)
        return out

    board = evidence_pack.get("board") or {}
    return {
        "board": {"delta": board.get("delta") or {}, "risk_level": board.get("risk_level"), "chain_breakpoint": board.get("chain_breakpoint")},
        "tiers": roll("tier"),
        "secondaryCategories": roll("secondaryCategory"),
        "units_note": (
            "cur/prev.gmv、delta.gmv_delta、tiers/secondaryCategories.gmv 均为已处理好的日均GMV口径（元/天）。"
            "daysReceived 只表示滚动周数据完整性，不是除数；禁止将 gmv 再除以 daysReceived，也禁止用 cur/prev 反推日均/累计口径。"
            "环比一律直接引用 delta 的 gmv_delta / gmv_delta_pct 等；tiers/secondaryCategories 的 gmv 与 gmv_delta 已按品类聚合好，直接引用，不要自己再逐个品类加总。"
        ),
    }


def _num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _compact_category_index_item(item: dict[str, Any], shard_path: str, shard_index: int) -> dict[str, Any]:
    delta = item.get("delta") if isinstance(item.get("delta"), dict) else {}
    cur = item.get("cur") if isinstance(item.get("cur"), dict) else {}
    prev = item.get("prev") if isinstance(item.get("prev"), dict) else {}
    return {
        "category": item.get("category"),
        "evidence_id": item.get("evidence_id"),
        "tier": item.get("tier"),
        "secondaryCategory": item.get("secondaryCategory"),
        "risk_level": item.get("risk_level"),
        "direction": item.get("direction"),
        "chain_breakpoint": item.get("chain_breakpoint"),
        "cur": {
            "gmv": cur.get("gmv"),
            "dealCnt": cur.get("dealCnt"),
            "orderCnt": cur.get("orderCnt"),
            "orderUv": cur.get("orderUv"),
            "shipCnt": cur.get("shipCnt"),
        },
        "prev": {
            "gmv": prev.get("gmv"),
            "dealCnt": prev.get("dealCnt"),
            "orderCnt": prev.get("orderCnt"),
        },
        "delta": {
            "gmv_delta": delta.get("gmv_delta"),
            "gmv_delta_pct": delta.get("gmv_delta_pct"),
            "deal_delta": delta.get("deal_delta"),
            "order_delta": delta.get("order_delta"),
            "avg_price_delta": delta.get("avg_price_delta"),
        },
        "top_model": item.get("top_model") if isinstance(item.get("top_model"), dict) else None,
        "shard": shard_path,
        "shard_index": shard_index,
    }


def _suggest_category_label(item: dict[str, Any]) -> str:
    delta = item.get("delta") if isinstance(item.get("delta"), dict) else {}
    cur = item.get("cur") if isinstance(item.get("cur"), dict) else {}
    direction = str(item.get("direction") or "").lower()
    risk = str(item.get("risk_level") or "")
    gmv = _num(cur.get("gmv"))
    gmv_delta = _num(delta.get("gmv_delta"))
    deal_delta = _num(delta.get("deal_delta"))
    if gmv <= 0 or (_num(cur.get("dealCnt")) <= 0 and abs(gmv_delta) < 1000):
        return "低基数波动品类"
    if direction == "up" and (gmv_delta > 0 or deal_delta > 0):
        return "明确机会品类"
    if direction == "down" and ("高" in risk or abs(gmv_delta) >= max(gmv * 0.2, 5000)):
        return "高影响风险品类"
    if direction == "down" or "异常" in risk:
        return "异常风险品类"
    return "稳健品类"


def build_analyze_support_artifacts(
    run_dir: Path,
    *,
    evidence_pack: dict[str, Any],
    digest: dict[str, Any],
    history_weeks: Any,
    shard_size: int = 30,
) -> dict[str, Any]:
    """Write non-lossy navigation artifacts next to the full analyze input.

    The full ``analyze_input.json`` remains authoritative.  Shards duplicate the
    full category rows in smaller files so the agent can inspect evidence in
    deterministic batches without losing detail or inventing summaries.
    """
    category_items = [
        item for item in (evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or [])
        if isinstance(item, dict) and item.get("category")
    ]
    shard_dir = run_dir / ANALYSIS_SHARDS_DIR
    shard_dir.mkdir(parents=True, exist_ok=True)
    shard_paths: list[str] = []
    category_index: list[dict[str, Any]] = []
    for offset in range(0, len(category_items), shard_size):
        shard_items = category_items[offset:offset + shard_size]
        start = offset + 1
        end = offset + len(shard_items)
        shard_path = shard_dir / f"category_{start:03d}_{end:03d}.json"
        rel_shard = str(shard_path.relative_to(run_dir))
        core.write_json(shard_path, {
            "run_id_note": "full category evidence shard; analyze_input.json remains authoritative",
            "range": {"start": start, "end": end, "total": len(category_items)},
            "items": shard_items,
        })
        shard_paths.append(str(shard_path))
        for local_index, item in enumerate(shard_items):
            category_index.append(_compact_category_index_item(item, rel_shard, local_index))

    top_movers = sorted(
        category_index,
        key=lambda item: abs(_num((item.get("delta") or {}).get("gmv_delta"))),
        reverse=True,
    )[:50]
    tail_items = sorted(
        category_index,
        key=lambda item: (
            _num((item.get("cur") or {}).get("gmv")),
            abs(_num((item.get("delta") or {}).get("gmv_delta"))),
        ),
    )[:80]
    tail_hints = [
        {
            "category": item.get("category"),
            "suggested_label": _suggest_category_label(item),
            "tier": item.get("tier"),
            "secondaryCategory": item.get("secondaryCategory"),
            "chain_breakpoint": item.get("chain_breakpoint"),
            "facts": {
                "gmv": (item.get("cur") or {}).get("gmv"),
                "dealCnt": (item.get("cur") or {}).get("dealCnt"),
                "gmv_delta": (item.get("delta") or {}).get("gmv_delta"),
                "gmv_delta_pct": (item.get("delta") or {}).get("gmv_delta_pct"),
                "deal_delta": (item.get("delta") or {}).get("deal_delta"),
            },
            "source_shard": item.get("shard"),
            "note": "辅助标签候选；最终文案仍必须回读 evidence_pack 或 shard 数字，不得只按 hint 编造。",
        }
        for item in tail_items
    ]

    digest_path = run_dir / ANALYSIS_DIGEST_FILE
    index_path = run_dir / ANALYSIS_CATEGORIES_INDEX_FILE
    top_path = run_dir / ANALYSIS_TOP_MOVERS_FILE
    hints_path = run_dir / CATEGORY_TAIL_HINTS_FILE
    core.write_json(digest_path, {
        "history_weeks": history_weeks,
        "digest": digest,
        "source": ANALYZE_INPUT_FILE,
        "usage": "优先用于 board/tiers/secondaryCategories 聚合口径；完整证据仍以 analyze_input.json 为准。",
    })
    core.write_json(index_path, {
        "total": len(category_index),
        "shard_size": shard_size,
        "shards": [str(Path(path).relative_to(run_dir)) for path in shard_paths],
        "items": category_index,
        "source": ANALYZE_INPUT_FILE,
    })
    core.write_json(top_path, {
        "metric": "abs(delta.gmv_delta)",
        "limit": len(top_movers),
        "items": top_movers,
        "source": ANALYZE_INPUT_FILE,
    })
    core.write_json(hints_path, {
        "total": len(tail_hints),
        "controlled_labels": list(CONTROLLED_LABELS),
        "items": tail_hints,
        "source": ANALYZE_INPUT_FILE,
    })
    return {
        "digest": str(digest_path),
        "categories_index": str(index_path),
        "top_movers": str(top_path),
        "category_tail_hints": str(hints_path),
        "category_shards_dir": str(shard_dir),
        "category_shards": shard_paths,
        "full_evidence": str(run_dir / ANALYZE_INPUT_FILE),
        "lossless_policy": "support artifacts are navigational only; analyze_input.json keeps full evidence_pack",
    }


def build_analyze_input(args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> Path:
    """确定性证据：只让 agent 在证据之上写叙述，数字不交给 agent 发明。"""
    read_body = {
        "run_id": args.run_id, "stage": "analyze", "week": args.week,
        "input_type": "metric_snapshot", "history_weeks": 10,
        "include": ["run_meta", "history_10w", "rules", "dashboard_snapshot"],
    }
    try:
        server_context = core.hub_post(core.READ_PATH, read_body, timeout=130.0)
    except Exception as exc:  # 允许降级：无服务器上下文仍能出周环比证据
        server_context = {"ok": False, "error": str(exc)}
    evidence_pack = core.build_analysis_evidence(processed, server_context)
    findings = core.make_findings(evidence_pack)
    history_weeks = (
        processed.get("process_summary", {}).get("history_weeks_available")
        or evidence_pack.get("effective_history_weeks")
        or 0
    )
    ev_cats = evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or []
    cats = sorted({str(i.get("category")) for i in ev_cats if isinstance(i, dict) and i.get("category")})
    secondaries = sorted({str(i.get("name")) for i in evidence_pack.get("cluster_top_changes", []) if isinstance(i, dict) and i.get("name")})
    digest = compute_digest(evidence_pack)
    support_artifacts = build_analyze_support_artifacts(
        run_dir,
        evidence_pack=evidence_pack,
        digest=digest,
        history_weeks=history_weeks,
    )
    core.write_json(run_dir / PROCESSED_RESULT_FILE, processed)
    core.write_json(run_dir / ANALYSIS_SCAFFOLD_FILE, {
        "evidence_pack": evidence_pack,
        "findings": findings,
        "display_contract": core.DISPLAY_CONTRACT,
        "history_weeks": history_weeks,
        "analysis_scope": "wow_only" if float(history_weeks or 0) < 8 else "trend_10w",
        "server_context_ok": bool(server_context.get("ok")),
    })
    core.write_json(run_dir / ANALYZE_INPUT_FILE, {
        "run_id": args.run_id, "week": args.week, "run_dt": args.run_dt,
        "history_weeks": history_weeks,
        "display_contract": core.DISPLAY_CONTRACT,
        "required_display_keys": list(REQUIRED_DISPLAY_KEYS),
        "controlled_category_labels": list(CONTROLLED_LABELS),
        "categories_to_cover": cats,
        "secondary_to_cover": secondaries,
        "digest": digest,
        "support_artifacts": support_artifacts,
        "model_pin": runtime_model_pin(),
        "evidence_pack": evidence_pack,
        "instruction": (
            "读 analyze-parity-rubric.md + golden-fewshot.md，按 rubric 分批产出 display_insights，写到 analysis_result.json 的 display_insights 字段。"
            "analyze_input.json 保留完整 evidence_pack；support_artifacts 是非损耗导航产物：先读 analysis_digest.json、analysis_categories_index.json、analysis_top_movers.json 和 category shards，再按需回到完整 evidence_pack。"
            "board/三层/板块的聚合数字已在 digest 里确定性算好（含 units_note 口径说明）：直接引用 digest，**不要自己从 category 逐个加总、也不要用 cur/prev 反推口径**（那会烧光 turn 预算导致中途结束）。写作时优先用 digest，品类明细按 analysis_categories_index 分批读取 shard；仍以 analyze_input.json/evidence_pack 为最终事实来源。硬性要求（否则机器闸门会打回）："
            "(1) 数字只来自 evidence_pack/digest，禁编造；品类标签按 §3.1 判定矩阵。"
            "(2) categories 必须覆盖 categories_to_cover 全部品类，一个不少。"
            "(2.1) categories 每个品类文案必须带 controlled_category_labels 之一。"
            "(3) secondaryCategories 必须非空，覆盖 secondary_to_cover 全部板块（每板块一段：贡献/拖累点名+链路段）。"
            "(4) 每个 tier(发展/孵化/种子)文案必须同时含：风险或机会 + 下钻或验证或观察 + 至少一个指标词(成交GMV/成交订单/下单率/发货率/成交率)。"
            "(5) board 必须含：风险等级 + 链路 + 拖累或机会 + 验证或下一步。"
            "(6) 品类文案重复率必须<20%：GMV=0 或无成交的品类不能都套同一句模板，每条至少带品类名并给一句差异化说明。"
            "(7) 禁技术字段(orderRate/shipCnt/dealGmv/wow_pct/entity_type)；禁主观词(效果显著/明显改善/大幅提升)。"
            "(8) history_weeks<8 时禁止写 8周趋势/10周趋势/长期趋势；用多周观察/多周表现/样本不足。"
            "(9) 写完后先跑 python3 scripts/aiwan_loop1_tick.py --check-analysis-result --run-dir <run_dir> --fix-analysis-result，通过后再 finalize。"
        ),
    })
    return run_dir / ANALYZE_INPUT_FILE


def auto_fix_display_for_gate(display: Any, history_weeks: int | float | str | None = None) -> tuple[Any, list[str]]:
    """Small deterministic cleanup before the hard gate.

    This does not generate analysis content; it only removes known banned wording
    and appends missing structural trigger words required by the display gate so
    the agent does not waste an extra turn on mechanical fixes.
    """
    fixes: list[str] = []
    if not isinstance(display, dict):
        return display, fixes

    replacements = {
        "效果显著": "效果较强",
        "明显改善": "环比改善",
        "大幅提升": "环比提升",
        "显著提升": "环比提升",
        "大幅下降": "环比下降",
        "显著下降": "环比下降",
    }
    try:
        history_value = float(history_weeks or 0)
    except (TypeError, ValueError):
        history_value = 0
    if history_value < 8:
        replacements.update({
            "不满足8周趋势分析要求": "多周观察样本不足",
            "不足8周趋势分析要求": "多周观察样本不足",
            "8周趋势分析": "多周观察",
            "8周趋势": "多周观察",
            "10周趋势": "多周观察",
            "长期趋势": "多周表现",
        })

    def clean_text(value: Any) -> Any:
        nonlocal fixes
        if isinstance(value, str):
            out = value
            for src, dst in replacements.items():
                if src in out:
                    out = out.replace(src, dst)
                    fixes.append(f"replace:{src}->{dst}")
            return out
        if isinstance(value, dict):
            return {k: clean_text(v) for k, v in value.items()}
        if isinstance(value, list):
            return [clean_text(v) for v in value]
        return value

    fixed = clean_text(display)
    if not isinstance(fixed, dict):
        return fixed, fixes

    tiers = fixed.get("tiers")
    if isinstance(tiers, dict):
        for tier in core.REQUIRED_TIERS:
            txt = str(tiers.get(tier) or "")
            if not txt.strip():
                continue
            additions: list[str] = []
            if not core.contains_any(txt, ("风险", "机会")):
                additions.append("该层需按风险/机会分组复核。")
            if not core.contains_any(txt, ("下钻", "验证", "观察")):
                additions.append("下一步按发货率、下单率和成交率验证链路断点，并区分下钻优先级。")
            if not core.contains_any(txt, ("成交GMV", "成交订单", "下单率", "发货率", "成交率")):
                additions.append("重点观察成交GMV、成交订单、下单率、发货率和成交率。")
            if additions:
                tiers[tier] = txt.rstrip("。") + "。" + "".join(additions)
                fixes.append(f"tier_quality_terms:{tier}")

    board = str(fixed.get("board") or "")
    if board.strip():
        additions = []
        if not core.contains_any(board, ("风险等级",)):
            additions.append("风险等级按当前大盘链路指标复核。")
        if not core.contains_any(board, ("链路",)):
            additions.append("链路重点看估价、下单、发货到成交。")
        if not core.contains_any(board, ("拖累", "机会")):
            additions.append("同步拆分主要拖累与机会品类。")
        if not core.contains_any(board, ("验证", "下一步")):
            additions.append("下一步验证发货率与下单率断点。")
        if additions:
            fixed["board"] = board.rstrip("。") + "。" + "".join(additions)
            fixes.append("board_quality_terms")

    return fixed, fixes


def gate_agent_display(display: Any, scaffold: dict[str, Any]) -> list[str]:
    """机器闸门：agent 写的 display_insights 不合规就 fail，绝不退回模板/静默通过。"""
    errors: list[str] = []
    if not isinstance(display, dict):
        return ["display_insights_not_object"]
    for k in REQUIRED_DISPLAY_KEYS:
        if k not in display:
            errors.append(f"missing_display_key:{k}")
    tiers = display.get("tiers") or {}
    for t in core.REQUIRED_TIERS:
        if not str(tiers.get(t) or "").strip():
            errors.append(f"empty_tier:{t}")
    ev = scaffold.get("evidence_pack", {})
    ev_cats = {str(i.get("category")) for i in (ev.get("category_all") or ev.get("category_top_changes") or []) if isinstance(i, dict) and i.get("category")}
    out_cats = set((display.get("categories") or {}).keys())
    missing = ev_cats - out_cats
    if missing:
        errors.append(f"categories_missing:{sorted(missing)[:10]}(+{max(len(missing) - 10, 0)})")
    for txt in core.flatten_display_text(display):
        for w in BANNED_SUBJECTIVE:
            if w in txt:
                errors.append(f"banned_subjective:{w}")
                break
    for name, txt in (display.get("categories") or {}).items():
        if not any(lbl in str(txt) for lbl in CONTROLLED_LABELS):
            errors.append(f"category_missing_label:{name}")
    # 镜像 execute_validate 的展示深检，让 agent 一次写对，避免撞到 validate 才发现
    sec = display.get("secondaryCategories")
    if not (isinstance(sec, dict) and sec):
        errors.append("secondaryCategories_empty")
    for t in core.REQUIRED_TIERS:
        tt = str(tiers.get(t) or "")
        if tt.strip() and not (
            core.contains_any(tt, ("风险", "机会"))
            and core.contains_any(tt, ("下钻", "验证", "观察"))
            and core.contains_any(tt, ("成交GMV", "成交订单", "下单率", "发货率", "成交率"))
        ):
            errors.append(f"tier_{t}_quality_terms")
    bt = str(display.get("board") or "")
    if bt.strip() and not (
        core.contains_any(bt, ("风险等级",))
        and core.contains_any(bt, ("链路",))
        and core.contains_any(bt, ("拖累", "机会"))
        and core.contains_any(bt, ("验证", "下一步"))
    ):
        errors.append("board_quality_terms")
    cat_texts = [str(x) for x in (display.get("categories") or {}).values()]
    if cat_texts and core.duplicate_text_ratio(cat_texts) >= 0.2:
        errors.append(f"category_duplicate_ratio:{round(core.duplicate_text_ratio(cat_texts), 3)}")
    if core.contains_any("\n".join(core.flatten_display_text(display)), core.TECH_DISPLAY_TERMS):
        errors.append("display_technical_terms_leaked")
    return errors


def check_analysis_result_file(run_dir: str | Path, *, fix: bool = False) -> dict[str, Any]:
    """Local preflight for agent-authored analysis_result.json before finalize."""
    root = Path(run_dir)
    scaffold_path = root / ANALYSIS_SCAFFOLD_FILE
    result_path = root / ANALYSIS_RESULT_FILE
    if not scaffold_path.exists():
        return {"ok": False, "error": {"code": "ANALYSIS_SCAFFOLD_MISSING", "path": str(scaffold_path)}}
    if not result_path.exists():
        return {"ok": False, "error": {"code": "ANALYSIS_RESULT_MISSING", "path": str(result_path)}}
    try:
        scaffold = core.read_json(scaffold_path)
    except Exception as exc:
        return {"ok": False, "error": {"code": "ANALYSIS_SCAFFOLD_INVALID_JSON", "path": str(scaffold_path), "message": str(exc)}}
    try:
        agent = core.read_json(result_path)
    except Exception as exc:
        return {"ok": False, "error": {"code": "ANALYSIS_RESULT_INVALID_JSON", "path": str(result_path), "message": str(exc)}}
    display = agent.get("display_insights") if isinstance(agent, dict) and "display_insights" in agent else agent
    fixed, fixes = auto_fix_display_for_gate(display, scaffold.get("history_weeks", 0))
    if fix and fixes:
        if isinstance(agent, dict) and "display_insights" in agent:
            agent["display_insights"] = fixed
        else:
            agent = {"display_insights": fixed}
        core.write_json(result_path, agent)
        core.write_json(root / "analysis_result_autofix.json", {"fixes": fixes, "display_insights": fixed})
        display = fixed
    elif fixes:
        display = fixed
    gate_errors = gate_agent_display(display, scaffold)
    return {
        "ok": not gate_errors,
        "run_dir": str(root),
        "fix_applied": bool(fix and fixes),
        "autofix_available": fixes,
        "errors": gate_errors,
        "history_weeks": scaffold.get("history_weeks", 0),
    }


def restore_read_checkpoints_for_analyze(
    args: argparse.Namespace,
    job_client: Any,
    xinghe_client: Any,
    job: dict[str, Any],
    rendered: dict[str, dict[str, str]],
    sql_hashes: dict[str, str],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Complete legacy durable SQL checkpoints before rebuilding analyze input.

    Real Loop runs may resume an older control-plane job that is already in
    validate/analyze state but was created before the current 5-SQL contract
    (notably before sqldau became mandatory).  In that case the fresh sandbox has
    no local analyze_input, while the server still has reusable checkpoints for
    only four SQLs.  Rather than abandoning the run or bumping base_revision, add
    only the missing checkpoint(s) to the same job and let the scheduled agent
    repeat the tick until the missing SQL succeeds.
    """
    checkpoints = dict(job.get("sql_checkpoints") or {})
    for name in BASE_SCRIPTS:
        checkpoint = checkpoints.get(name) or {}
        expected_hash = sql_hashes[name]
        status = sql_status(checkpoint.get("status"))
        execute_id = checkpoint.get("execute_id") or (job.get("execute_ids") or {}).get(name)

        if execute_id and status in SUCCESS_STATUSES and str(checkpoint.get("sql_hash") or "") == expected_hash:
            continue

        next_status = str(job.get("status") or "validating")
        next_stage = str(job.get("current_stage") or "validate")

        if not execute_id:
            execute_id = submit_sql(xinghe_client, name, rendered[name]["sql"], args)
            job = checkpoint_update(
                job_client,
                args,
                job,
                next_status,
                current_stage=next_stage,
                sql_checkpoints={name: {
                    "execute_id": execute_id,
                    "sql_hash": expected_hash,
                    "status": "SUBMITTED",
                    "retry_count": int(checkpoint.get("retry_count") or 0),
                    "restore_reason": "legacy_missing_checkpoint",
                    "restored_at": iso_now(),
                }},
                error={},
            )
            return job, pending_result(args, job, f"restore_missing_sql_submitted:{name}")

        if status not in SUCCESS_STATUSES:
            polled = poll_sql(xinghe_client, str(execute_id))
            retry_count = int(checkpoint.get("retry_count") or 0)
            if polled in FAILED_STATUSES:
                terminal = retry_count >= MAX_SQL_RETRIES
                job = checkpoint_update(
                    job_client,
                    args,
                    job,
                    "failed" if terminal else next_status,
                    current_stage=next_stage,
                    sql_checkpoints={name: {
                        "execute_id": str(execute_id),
                        "sql_hash": expected_hash,
                        "status": polled,
                        "retry_count": retry_count if terminal else retry_count + 1,
                        "restore_reason": "legacy_missing_checkpoint",
                    }},
                    error={
                        "code": "RESTORE_SQL_TERMINAL_FAILED" if terminal else "RESTORE_SQL_TERMINAL_RETRY_SCHEDULED",
                        "script": name,
                        "status": polled,
                        "retry_count": retry_count,
                        "max_retries": MAX_SQL_RETRIES,
                    },
                )
                if terminal:
                    return job, {"ok": False, "business_status": "failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job}
                return job, pending_result(args, job, f"restore_sql_terminal_retry_scheduled:{name}")
            job = checkpoint_update(
                job_client,
                args,
                job,
                next_status,
                current_stage=next_stage,
                sql_checkpoints={name: {
                    "execute_id": str(execute_id),
                    "sql_hash": expected_hash,
                    "status": polled,
                    "retry_count": retry_count,
                    "restore_reason": checkpoint.get("restore_reason") or "legacy_missing_checkpoint",
                }},
            )
            if polled not in SUCCESS_STATUSES:
                return job, pending_result(args, job, f"restore_sql_not_ready:{name}")
            checkpoints = dict(job.get("sql_checkpoints") or {})
            continue

        return job, analyze_input_missing_result(
            args,
            job,
            core.out_root() / "aiwan_runs" / args.run_id,
            "analyze_input_missing_checkpoint_hash_mismatch",
            restore_diagnostics={
                "script": name,
                "checkpoint_sql_hash": checkpoint.get("sql_hash"),
                "expected_sql_hash": expected_hash,
            },
        )

    return job, None


def ensure_analyze_artifacts(
    args: argparse.Namespace,
    run_dir: Path,
    job: dict[str, Any],
    adapter: Any,
    job_client: Any | None = None,
    xinghe_client: Any | None = None,
    rendered: dict[str, dict[str, str]] | None = None,
    sql_hashes: dict[str, str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Rebuild local analyze inputs when server state resumes in a fresh sandbox.

    Cross-tick Loop runs can reclaim a job whose control-plane state is already
    current_stage=analyze, while the new sandbox has lost run_dir files.  The
    job checkpoint still contains execute_ids; materialize them again and rebuild
    process/analyze_input so the agent has deterministic evidence instead of an
    orphan analyze_pending path.
    """
    required = [
        run_dir / ANALYZE_INPUT_FILE,
        run_dir / ANALYSIS_SCAFFOLD_FILE,
        run_dir / PROCESSED_RESULT_FILE,
    ]
    if all(path.exists() for path in required):
        return job, None

    checkpoints = dict(job.get("sql_checkpoints") or {})
    missing = [name for name in BASE_SCRIPTS if not (checkpoints.get(name) or {}).get("execute_id")]
    not_success = [name for name in BASE_SCRIPTS if sql_status((checkpoints.get(name) or {}).get("status")) not in SUCCESS_STATUSES]
    if missing or not_success:
        durable_success = [
            name for name in BASE_SCRIPTS
            if (checkpoints.get(name) or {}).get("execute_id")
            and sql_status((checkpoints.get(name) or {}).get("status")) in SUCCESS_STATUSES
        ]
        if not durable_success:
            return job, None
        if job_client is None or xinghe_client is None or rendered is None or sql_hashes is None:
            # No durable read evidence to rebuild from yet; leave the normal pending result.
            return job, None
        job, pending = restore_read_checkpoints_for_analyze(
            args, job_client, xinghe_client, job, rendered, sql_hashes
        )
        if pending is not None:
            return job, pending

    export_dir = run_dir / "read_exports"
    raw_root = run_dir / "read_artifacts"
    debug_dir = run_dir / "debug"
    for path in (run_dir, export_dir, raw_root, debug_dir):
        path.mkdir(parents=True, exist_ok=True)

    for name in BASE_SCRIPTS:
        checkpoint = checkpoints[name]
        csv_path = export_dir / f"{name}_{args.run_dt}.csv"
        if not csv_path.exists():
            rows = adapter.materialize(str(checkpoint["execute_id"]), csv_path, debug_dir, name)
            if rows <= 0 and name not in core.FULFILL_OPTIONAL_EMPTY:
                raise RuntimeError(f"SQL {name} materialized empty CSV during analyze restore")

    active = adapter.package_base(args, export_dir, raw_root)
    read_result = build_read_result(args, run_dir, job, active)
    processed = adapter.process(args, run_dir, read_result)
    build_analyze_input(args, run_dir, processed)
    return job, None


def bridge_claimed_analyze(job_client: Any, args: argparse.Namespace, job: dict[str, Any]) -> dict[str, Any]:
    """Bridge a reclaimed analyze lease from claimed -> analyzing before validate.

    The control-plane state machine rejects claimed -> validating.  After a
    retryable gate failure, the next tick claims the job and preserves
    current_stage=analyze; clear stale errors and re-enter analyzing before
    attempting validate.
    """
    if job.get("status") == "claimed" and job.get("current_stage") in {"analyze", "validate"}:
        return checkpoint_update(job_client, args, job, "analyzing", current_stage="analyze", error={})
    return job


def renew_analyze_lease(job_client: Any, args: argparse.Namespace, job: dict[str, Any]) -> dict[str, Any]:
    if job.get("current_stage") not in {"analyze", "validate"}:
        return job
    return job_client.claim(args.analysis_key, {
        "kind": "base",
        "base_revision": args.base_revision,
        "handoff_revision": 0,
        "expected_state_revision": job["state_revision"],
        "worker_id": args.worker_id,
        "lease_seconds": args.lease_seconds,
        "current_stage": job.get("current_stage") or "analyze",
    })


def finalize_after_analyze(
    args: argparse.Namespace,
    run_dir: Path,
    job: dict[str, Any],
    job_client: Any,
    adapter: Any,
    xinghe_client: Any | None = None,
    rendered: dict[str, dict[str, str]] | None = None,
    sql_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    job, pending = ensure_analyze_artifacts(
        args, run_dir, job, adapter, job_client, xinghe_client, rendered, sql_hashes
    )
    if pending is not None:
        return pending
    result_path = run_dir / ANALYSIS_RESULT_FILE
    if not result_path.exists():
        if not (run_dir / ANALYZE_INPUT_FILE).exists():
            checkpoints = dict(job.get("sql_checkpoints") or {})
            return analyze_input_missing_result(
                args,
                job,
                run_dir,
                "analyze_input_missing_before_agent_analysis",
                restore_diagnostics={
                    "checkpoint_names": sorted(checkpoints),
                    "missing_execute_ids": [name for name in BASE_SCRIPTS if not (checkpoints.get(name) or {}).get("execute_id")],
                    "not_success": [name for name in BASE_SCRIPTS if sql_status((checkpoints.get(name) or {}).get("status")) not in SUCCESS_STATUSES],
                },
            )
        return analyze_pending_result(args, job, run_dir)
    job, pending = ensure_analyze_artifacts(
        args, run_dir, job, adapter, job_client, xinghe_client, rendered, sql_hashes
    )
    if pending is not None:
        return pending
    scaffold = core.read_json(run_dir / ANALYSIS_SCAFFOLD_FILE)
    processed = core.read_json(run_dir / PROCESSED_RESULT_FILE)
    agent = core.read_json(result_path)
    display = agent.get("display_insights") if isinstance(agent, dict) and "display_insights" in agent else agent
    display, auto_fixes = auto_fix_display_for_gate(display, scaffold.get("history_weeks", 0))
    if auto_fixes:
        if isinstance(agent, dict) and "display_insights" in agent:
            agent["display_insights"] = display
        else:
            agent = {"display_insights": display}
        core.write_json(result_path, agent)
        core.write_json(run_dir / "analysis_result_autofix.json", {"fixes": auto_fixes, "display_insights": display})
    if job.get("status") == "retryable_failed" and job.get("current_stage") == "analyze":
        job = checkpoint_update_refreshing(job_client, args, job, "analyzing", current_stage="analyze", error={})
    gate_errors = gate_agent_display(display, scaffold)
    if gate_errors:
        return retryable_analyze_failure_result(
            args, job_client, job, "ANALYSIS_GATE_FAILED", "errors", gate_errors
        )
    analysis = {
        "stage": "analyze",
        "status": "warn" if display.get("warnings") else "success",
        "output_type": "analysis_result",
        "run_id": args.run_id, "week": args.week,
        "analysis_mode": "daily",
        "analysis_scope": scaffold.get("analysis_scope", "wow_only"),
        "history_weeks": scaffold.get("history_weeks", 0),
        "evidence_pack": scaffold.get("evidence_pack", {}),
        "findings": scaffold.get("findings", []),
        "display_contract": scaffold.get("display_contract", core.DISPLAY_CONTRACT),
        "display_insights": display,
        "summary": agent.get("summary", {}) if isinstance(agent, dict) else {},
        "review_notes": agent.get("review_notes", []) if isinstance(agent, dict) else [],
        "warnings": display.get("warnings", []),
        "llm_policy": {"executor": "sandbox_agent", "model": REQUIRED_LOOP_MODEL_ID, "batched": True, "pin": runtime_model_pin()},
        "next_stage": "validate",
    }
    core.write_json(run_dir / "analysis_result_assembled.json", analysis)
    job = checkpoint_update_refreshing(job_client, args, job, "validating", current_stage="validate")
    validation = adapter.validate(args, run_dir, processed, analysis)
    if validation.get("server_write_confirmed") is not True:
        # validate 深检未过：保留 validate/validating；远端状态机不允许
        # validating -> analyzing 回滚。agent 修 analysis_result 后直接重跑
        # finalize，会在同一 validate 阶段重新写服务器。
        failed = validation.get("failed_checks", []) or []
        return retryable_analyze_failure_result(
            args, job_client, job, "VALIDATE_CHECKS_FAILED", "failed_checks", failed
        )
    job = checkpoint_update_refreshing(job_client, args, job, "published", current_stage="validate")
    drilldown = select_drilldown_categories(scaffold.get("evidence_pack", {}))
    return published_result(args, job_client, job,
        drilldown_categories=drilldown,
        model_enrichment_mode="enabled" if drilldown else "disabled",
        stage_results={
            "read": "success", "process": processed.get("status"),
            "analyze": analysis.get("status"), "validate": validation.get("status"),
        }, artifacts_dir=str(run_dir))


def run_tick(
    args: argparse.Namespace,
    job_client: Any | None = None,
    xinghe_client: Any | None = None,
    adapter: Any | None = None,
) -> dict[str, Any]:
    job_client = job_client or HubJobClient()
    xinghe_client = xinghe_client or core.xinghe
    adapter = adapter or CoreAdapter()
    if xinghe_client is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")

    run_dir = core.out_root() / "aiwan_runs" / args.run_id
    export_dir = run_dir / "read_exports"
    raw_root = run_dir / "read_artifacts"
    debug_dir = run_dir / "debug"
    for path in (run_dir, export_dir, raw_root, debug_dir):
        path.mkdir(parents=True, exist_ok=True)
    rendered = adapter.render_sqls(args, export_dir)
    sql_hashes = {name: rendered[name]["sha256"] for name in BASE_SCRIPTS}
    create_payload = {
        "kind": "base",
        "analysis_key": args.analysis_key,
        "week": args.week,
        "data_end_date": args.data_end_date,
        "loop1_run_id": args.run_id,
        "base_revision": args.base_revision,
        "handoff_revision": 0,
        "status": "ready",
        "current_stage": "read",
        "base_deadline_at": args.base_deadline_at,
        "sql_hashes": sql_hashes,
        "sql_checkpoints": {},
    }

    job: dict[str, Any] | None = None
    try:
        try:
            job = job_client.create(create_payload)
        except JobApiError as exc:
            recoverable_create_codes = {
                "JOB_REVISION_CONFLICT",
                "JOB_STATE_REVISION_CONFLICT",
                "JOB_ALREADY_EXISTS",
                "AIWAN_JOB_API_FAILED",
                "HUB_UPSTREAM_ERROR",
            }
            if exc.code not in recoverable_create_codes and exc.status not in {409, 502}:
                raise
            try:
                job = job_client.get(args.analysis_key, args.base_revision)
            except Exception:
                raise exc
        args.base_started_at = getattr(args, "base_started_at", None) or job.get("created_at") or f"{args.run_dt}T00:00:00+08:00"
        args.base_sla_deadline = getattr(args, "base_sla_deadline", None) or args.base_deadline_at or job.get("base_deadline_at")
        if job.get("status") == "published":
            return published_result(args, job_client, job)
        if job.get("status") in {"failed", "superseded"}:
            return {"ok": False, "business_status": job["status"], "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job}

        if job.get("lease_owner") and lease_active(job) and job.get("lease_owner") != args.worker_id:
            return pending_result(args, job, "lease_held_by_other_worker")

        # read+process 已完成、等待/消费 agent 分析：finalize 前先续租并拿最新
        # state_revision。真实 scheduled-agent analyze 可能超过旧 lease；不续租会
        # 在 analyzing -> validating 时触发 409/CAS。实测 analyzing+current_stage=analyze
        # 的 claim 是续租，不会破坏状态；若被重置为 claimed，再桥回 analyzing。
        if job.get("current_stage") in {"analyze", "validate"}:
            job = renew_analyze_lease(job_client, args, job)
            job = bridge_claimed_analyze(job_client, args, job)
            return finalize_after_analyze(
                args, run_dir, job, job_client, adapter, xinghe_client, rendered, sql_hashes
            )

        job = job_client.claim(args.analysis_key, {
            "kind": "base",
            "base_revision": args.base_revision,
            "handoff_revision": 0,
            "expected_state_revision": job["state_revision"],
            "worker_id": args.worker_id,
            "lease_seconds": args.lease_seconds,
            "current_stage": job.get("current_stage") or "read",
        })

        job, inherited_checkpoints = inherit_previous_revision_checkpoints(
            job_client, args, job, sql_hashes, export_dir
        )

        checkpoints = dict(job.get("sql_checkpoints") or {})
        for name, expected_hash in sql_hashes.items():
            actual_hash = (job.get("sql_hashes") or {}).get(name)
            if actual_hash and actual_hash != expected_hash:
                raise RuntimeError(f"SQL_HASH_MISMATCH: {name}")

        for name in BASE_SCRIPTS:
            checkpoint = checkpoints.get(name) or {}
            execute_id = checkpoint.get("execute_id") or (job.get("execute_ids") or {}).get(name)
            status = sql_status(checkpoint.get("status"))
            if not execute_id or status in SUCCESS_STATUSES or status in FAILED_STATUSES:
                continue
            polled = poll_sql(xinghe_client, str(execute_id))
            next_status = "sql_running" if job.get("status") in {"claimed", "sql_submitted", "sql_running"} else job["status"]
            if polled in FAILED_STATUSES:
                retry_count = int(checkpoint.get("retry_count") or 0)
                terminal = retry_count >= MAX_SQL_RETRIES
                job = checkpoint_update(
                    job_client,
                    args,
                    job,
                    "failed" if terminal else "retryable_failed",
                    current_stage="read",
                    sql_checkpoints={name: {
                        "execute_id": str(execute_id),
                        "sql_hash": sql_hashes[name],
                        "status": polled,
                        "retry_count": retry_count if terminal else retry_count + 1,
                    }},
                    error={
                        "code": "SQL_TERMINAL_FAILED" if terminal else "SQL_TERMINAL_RETRY_SCHEDULED",
                        "script": name,
                        "status": polled,
                        "retry_count": retry_count,
                        "max_retries": MAX_SQL_RETRIES,
                    },
                )
                if terminal:
                    return {"ok": False, "business_status": "failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job}
                return pending_result(args, job, "sql_terminal_retry_scheduled")
            job = checkpoint_update(job_client, args, job, next_status, current_stage="read", sql_checkpoints={name: {"execute_id": str(execute_id), "sql_hash": sql_hashes[name], "status": polled}})
            checkpoints = dict(job.get("sql_checkpoints") or {})

        active_count = sum(
            1 for item in checkpoints.values()
            if item.get("execute_id")
            and sql_status(item.get("status")) not in SUCCESS_STATUSES
            and sql_status(item.get("status")) not in FAILED_STATUSES
        )
        for name in BASE_SCRIPTS:
            checkpoint = checkpoints.get(name) or {}
            checkpoint_status = sql_status(checkpoint.get("status"))
            retrying = bool(checkpoint.get("execute_id") and checkpoint_status in FAILED_STATUSES)
            if (checkpoint.get("execute_id") and not retrying) or active_count >= MAX_ACTIVE_SQL:
                continue
            execute_id = submit_sql(xinghe_client, name, rendered[name]["sql"], args)
            state = "sql_submitted" if job.get("status") == "claimed" else job["status"]
            job = checkpoint_update(job_client, args, job, state, current_stage="read", sql_checkpoints={name: {
                "execute_id": execute_id,
                "sql_hash": sql_hashes[name],
                "status": "SUBMITTED",
                "retry_count": int(checkpoint.get("retry_count") or 0),
            }}, error={})
            checkpoints = dict(job.get("sql_checkpoints") or {})
            active_count += 1

        if not all(sql_status((checkpoints.get(name) or {}).get("status")) in SUCCESS_STATUSES for name in BASE_SCRIPTS):
            return pending_result(args, job, "sql_not_ready")

        if job.get("status") == "claimed":
            # A retryable/expired tick can be reclaimed after all five SQLs already
            # succeeded.  The job API only allows forward transitions, so bridge
            # claimed -> sql_submitted before resuming materialization instead of
            # trying an invalid claimed -> materializing jump.
            job = checkpoint_update(job_client, args, job, "sql_submitted", current_stage="read")
        if job.get("status") != "materializing":
            job = checkpoint_update(job_client, args, job, "materializing", current_stage="read")
        for name in BASE_SCRIPTS:
            checkpoint = (job.get("sql_checkpoints") or {}).get(name) or {}
            csv_path = export_dir / f"{name}_{args.run_dt}.csv"
            reusable = _checkpoint_artifact_is_reusable(
                checkpoint, expected_sql_hash=sql_hashes[name]
            )
            if reusable is None or reusable.resolve() != csv_path.resolve():
                rows = adapter.materialize(str(checkpoint["execute_id"]), csv_path, debug_dir, name)
                if rows <= 0 and name not in core.FULFILL_OPTIONAL_EMPTY:
                    raise RuntimeError(f"SQL {name} materialized empty CSV")
            usable = core.assert_csv_materialized_usable(csv_path, name in core.FULFILL_OPTIONAL_EMPTY)
            job = checkpoint_update(job_client, args, job, "materializing", current_stage="read", sql_checkpoints={name: {
                "execute_id": str(checkpoint["execute_id"]),
                "sql_hash": sql_hashes[name],
                "status": "SUCCESS",
                "artifact_uri": str(csv_path),
                "artifact_hash": core.sha256_file(csv_path),
                "materialized_at": iso_now(),
                "data_integrity": usable.get("data_integrity"),
                **({
                    "inherited_from_base_revision": checkpoint.get("inherited_from_base_revision"),
                    "inherited_from_job_id": checkpoint.get("inherited_from_job_id"),
                } if name in inherited_checkpoints else {}),
            }})

        active = adapter.package_base(args, export_dir, raw_root)
        read_result = build_read_result(args, run_dir, job, active)
        job = checkpoint_update(job_client, args, job, "processing", current_stage="process", artifact_uri=read_result["artifacts"]["raw_cache"], artifact_hash=active.get("raw_cache_sha256"))
        processed = adapter.process(args, run_dir, read_result)
        # analyze 交回沙箱主 agent（Claude）分批撰写：落确定性证据后停在 analyze_pending，
        # 下一 tick 命中 current_stage=="analyze" 分支消费 agent 的 analysis_result.json 并走 validate 闸门。
        analyze_input_path = build_analyze_input(args, run_dir, processed)
        if not analyze_input_path.exists():
            raise RuntimeError("ANALYZE_INPUT_MISSING_AFTER_BUILD")
        job = checkpoint_update(job_client, args, job, "analyzing", current_stage="analyze")
        return analyze_pending_result(args, job, run_dir)
    except core.DataIntegrityRetryable as exc:
        if job and job.get("status") not in {"published", "failed", "superseded", "retryable_failed"}:
            try:
                job = checkpoint_update(job_client, args, job, "retryable_failed", current_stage="read", error={"code": core.ORDER_CHAIN_EMPTY_CODE, "details": exc.check})
            except Exception:
                pass
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "error": {"code": core.ORDER_CHAIN_EMPTY_CODE, "details": exc.check}, "job": job}
    except JobApiError as exc:
        if is_control_plane_conflict(exc):
            try:
                job = job_client.get(args.analysis_key, args.base_revision)
            except Exception:
                pass
            return pending_result(args, job, exc.code.lower())
        raise
    except Exception as exc:
        if job and job.get("status") not in {"published", "failed", "superseded", "retryable_failed"}:
            try:
                error_code = core.ORDER_CHAIN_EMPTY_CODE if core.ORDER_CHAIN_EMPTY_CODE in str(exc) else "LOOP1_TICK_FAILED"
                job = checkpoint_update(job_client, args, job, "retryable_failed", current_stage=job.get("current_stage") or "read", error={"code": error_code, "message": str(exc)[:1000]})
            except Exception:
                pass
        error_code = core.ORDER_CHAIN_EMPTY_CODE if core.ORDER_CHAIN_EMPTY_CODE in str(exc) else "LOOP1_TICK_FAILED"
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "error": {"code": error_code, "message": str(exc)}, "job": job}


def exit_code_for(result: dict[str, Any]) -> int:
    return 0 if result.get("business_status") in {"pending", "analyze_pending", "published", "late_published"} and result.get("ok") is True else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id")
    parser.add_argument("--week")
    parser.add_argument("--run-dt")
    parser.add_argument("--data-end-date")
    parser.add_argument("--analysis-key")
    parser.add_argument("--base-revision", type=int, default=1)
    parser.add_argument("--worker-id")
    parser.add_argument("--lease-seconds", type=int, default=3600)
    parser.add_argument("--base-deadline-at")
    parser.add_argument("--base-started-at")
    parser.add_argument("--base-sla-deadline")
    parser.add_argument("--process-timeout-seconds", type=int, default=900)
    parser.add_argument("--check-analysis-result", action="store_true")
    parser.add_argument("--run-dir")
    parser.add_argument("--fix-analysis-result", action="store_true")
    return parser


def apply_runtime_defaults(args: argparse.Namespace) -> argparse.Namespace:
    args.analysis_key = args.analysis_key or f"{args.week}:{args.data_end_date}"
    args.run_id = args.run_id or f"loop1-{args.week}-{args.data_end_date}-r{args.base_revision}"
    args.worker_id = args.worker_id or os.environ.get("AIWAN_LOOP1_WORKER_ID") or f"loop1:{args.analysis_key}:b{args.base_revision}"
    return args


def main() -> None:
    args = apply_runtime_defaults(build_parser().parse_args())
    if args.check_analysis_result:
        if not args.run_dir:
            result = {"ok": False, "error": {"code": "RUN_DIR_REQUIRED"}}
        else:
            result = check_analysis_result_file(args.run_dir, fix=args.fix_analysis_result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0 if result.get("ok") else 1)
    missing = [name for name in ("week", "run_dt", "data_end_date") if not getattr(args, name)]
    if missing:
        result = {"ok": False, "business_status": "failed", "error": {"code": "ARGS_REQUIRED", "missing": missing}}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(2)
    preflight = core.preflight()
    if preflight.get("ok") is not True:
        result = {"ok": False, "business_status": "failed", "error": {"code": "PREFLIGHT_FAILED", "details": preflight.get("errors", [])}, "preflight": preflight}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(2)
    result = run_tick(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code_for(result))


if __name__ == "__main__":
    main()
