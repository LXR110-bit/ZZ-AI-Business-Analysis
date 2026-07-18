from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from process_pipeline import BASE_SCRIPTS, RAW_SCRIPTS, process_raw_cache  # noqa: E402


RUN_DT = "2026-07-15"
CSV_BY_SCRIPT = {
    "category_daily_avg": "week_start_date,cate_name,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,7,700,350,210,140,120,110,100,80,5,80000\n2026-07-13,手机,3,300,150,90,60,50,45,40,32,2,32000\n",
    "category_summary": "week_start_date,cate_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,4900,2450,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,900,450,270,180,150,135,120,96,6,96000\n",
    "category_fulfill_daily_avg": "week_start_date,cate_name_label,fulfill_type,day_cnt,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,7,210,140,120,110,100,80,5,80000\n2026-07-13,手机,邮寄,3,90,60,50,45,40,32,2,32000\n",
    "category_fulfill_summary": "week_start_date,cate_name_label,fulfill_type,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,邮寄,270,180,150,135,120,96,6,96000\n",
    "model_daily_avg": "week_start_date,cate_name_label,model_id_col,model_name_label,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,7,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,3,150,75,45,30,25,22,20,16,1,16000\n",
    "model_summary": "week_start_date,cate_name_label,model_id_col,model_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,150,75,45,30,25,22,20,16,1,16000\n",
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_snapshot(path: Path) -> None:
    write_json(path / "tags.json", {"手机||iPhone 15": {"dimensions": {"core": "核心"}, "tags": ["核心"], "note": ""}})
    write_json(path / "tag-vocab.json", {"core": ["核心", "非核心", "观察"], "lifecycle": ["新品", "主流", "长尾", "淘汰"], "price": ["高价段", "中价段", "低价段"], "custom": {}})
    (path / "category_mapping.csv").write_text("三级品类,阶段,业务状态,二级板块,归类置信度\n手机,发展,在售,手机通讯,高\n", encoding="utf-8")


def build_fetch(path: Path, scripts: tuple[str, ...], *, sql_scope: str | None,
                declared_scripts: tuple[str, ...] | None = None,
                extra_raw_scripts: tuple[str, ...] = ()) -> None:
    fetch_id = f"fetch_{sql_scope or 'legacy'}"
    archive = path / f"raw_cache_{RUN_DT}.zip"
    declared = declared_scripts if declared_scripts is not None else scripts
    raw_manifest: dict[str, object] = {"run_id": fetch_id, "run_dt": RUN_DT}
    sql_status: dict[str, object] = {"run_id": fetch_id, "run_dt": RUN_DT}
    if sql_scope is not None:
        raw_manifest.update({"sql_scope": sql_scope, "scripts": list(declared)})
        sql_status.update({"sql_scope": sql_scope, "active_scripts": list(declared), "scripts": {script: {"status": "SUCCESS"} for script in declared}})
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        for script in tuple(dict.fromkeys((*scripts, *extra_raw_scripts))):
            output.writestr(f"raw/{script}_{RUN_DT}.csv", CSV_BY_SCRIPT[script])
        output.writestr(f"raw_manifest_{RUN_DT}.json", json.dumps(raw_manifest, ensure_ascii=False))
        output.writestr(f"sql_status_{RUN_DT}.json", json.dumps(sql_status, ensure_ascii=False))
    active: dict[str, object] = {
        "contract_version": "ai-wan-v1.5.5-fetch",
        "stage": "fetch",
        "status": "success",
        "run_id": fetch_id,
        "run_dt": RUN_DT,
        "raw_cache": archive.name,
        "raw_cache_sha256": sha256(archive),
        "raw_manifest": f"raw_manifest_{RUN_DT}.json",
        "sql_status": f"sql_status_{RUN_DT}.json",
        "known_gaps": [],
    }
    if sql_scope is not None:
        active.update({"sql_scope": sql_scope, "scripts": list(declared)})
    write_json(path / "active_fetch_manifest.json", active)


def unzip(path: Path, target: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        archive.extractall(target)


class ProcessPipelineScopeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="aiwan-python-process-")
        self.root = Path(self.temp.name)
        self.snapshot = self.root / "snapshot"
        build_snapshot(self.snapshot)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_process(self, input_dir: Path, out_dir: Path, run_id: str, previous: Path | None = None) -> dict[str, object]:
        return process_raw_cache(
            run_dt=RUN_DT,
            run_id=run_id,
            input_dir=input_dir,
            out_dir=out_dir,
            snapshot_dir=self.snapshot,
            category_mapping_file=self.snapshot / "category_mapping.csv",
            previous_processed_cache=previous,
        )

    def test_legacy_default_remains_full6(self) -> None:
        fetch = self.root / "legacy-fetch"
        output = self.root / "legacy-output"
        fetch.mkdir()
        build_fetch(fetch, RAW_SCRIPTS, sql_scope=None)
        result = self.run_process(fetch, output, "legacy_process")
        self.assertTrue(result["ok"], result)
        manifest = result["manifest"]
        self.assertEqual(manifest["sql_scope"], "all")
        self.assertEqual(manifest["scripts"], list(RAW_SCRIPTS))
        self.assertEqual(manifest["model_enrichment_status"], "ready")
        extracted = self.root / "legacy-inspect"
        unzip(output / manifest["processed_cache"], extracted)
        model_cache = json.loads((extracted / "cache/model-cache.json").read_text(encoding="utf-8"))
        self.assertGreater(len(model_cache["rows"]), 0)

    def test_base4_removes_previous_models_and_publishes_disabled_cache(self) -> None:
        full_fetch = self.root / "full-fetch"
        full_output = self.root / "full-output"
        full_fetch.mkdir()
        build_fetch(full_fetch, RAW_SCRIPTS, sql_scope="all")
        full = self.run_process(full_fetch, full_output, "full_process")
        self.assertTrue(full["ok"], full)
        previous = full_output / full["manifest"]["processed_cache"]

        base_fetch = self.root / "base-fetch"
        base_output = self.root / "base-output"
        base_fetch.mkdir()
        build_fetch(base_fetch, BASE_SCRIPTS, sql_scope="base")
        base = self.run_process(base_fetch, base_output, "base_process", previous)
        self.assertTrue(base["ok"], base)
        manifest = base["manifest"]
        self.assertEqual(manifest["sql_scope"], "base")
        self.assertEqual(manifest["scripts"], list(BASE_SCRIPTS))
        self.assertEqual(manifest["model_enrichment_status"], "disabled")

        extracted = self.root / "base-inspect"
        unzip(base_output / manifest["processed_cache"], extracted)
        self.assertFalse(any(path.name.startswith("model_") for path in (extracted / "imports").glob("*.csv")))
        model_cache = json.loads((extracted / "cache/model-cache.json").read_text(encoding="utf-8"))
        self.assertEqual(model_cache["status"], "disabled")
        self.assertEqual(model_cache["source"]["reason"], "model_sql_excluded_from_base_scope")
        self.assertEqual(model_cache["categories"], [])
        self.assertEqual(model_cache["weeks"], [])
        self.assertEqual(model_cache["rows"], [])
        history = json.loads((base_output / manifest["analysis_history"]).read_text(encoding="utf-8"))
        self.assertEqual(history["model_topn_history"], [])
        self.assertEqual(history["model_detail_contributor_candidates"], [])

        server = self.root / "base-server"
        unzip(base_output / manifest["server_cache_bundle"], server)
        published = json.loads((server / "model-cache.json").read_text(encoding="utf-8"))
        self.assertEqual(published["status"], "disabled")
        self.assertEqual(published["rows"], [])

    def test_base_scope_ignores_undeclared_model_csv_instead_of_fabricating_evidence(self) -> None:
        fetch = self.root / "fake-model-fetch"
        output = self.root / "fake-model-output"
        fetch.mkdir()
        build_fetch(fetch, BASE_SCRIPTS, sql_scope="base", extra_raw_scripts=("model_daily_avg",))
        result = self.run_process(fetch, output, "fake_model_process")
        self.assertTrue(result["ok"], result)
        extracted = self.root / "fake-model-inspect"
        unzip(output / result["manifest"]["processed_cache"], extracted)
        model_cache = json.loads((extracted / "cache/model-cache.json").read_text(encoding="utf-8"))
        self.assertEqual(model_cache["status"], "disabled")
        self.assertEqual(model_cache["rows"], [])
        self.assertFalse(any(path.name.startswith("model_") for path in (extracted / "imports").glob("*.csv")))

    def test_scope_metadata_rejects_non_exact_active_script_set(self) -> None:
        fetch = self.root / "invalid-fetch"
        output = self.root / "invalid-output"
        fetch.mkdir()
        invalid = (*BASE_SCRIPTS, "model_daily_avg")
        build_fetch(fetch, BASE_SCRIPTS, sql_scope="base", declared_scripts=invalid, extra_raw_scripts=("model_daily_avg",))
        result = self.run_process(fetch, output, "invalid_process")
        self.assertFalse(result["ok"])
        self.assertIn("do not match sql_scope=base", "\n".join(result["report"]["errors"]))


if __name__ == "__main__":
    unittest.main()
