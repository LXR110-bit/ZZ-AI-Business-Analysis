"""任务C：核心机型快照加载与 §6.3 同步校验。

业务飞书 sheet 尚未提供，包内 core-models.json 为占位空快照；Loop2 在快照不可用时
降级为 异动机型 + GMV Top-N 兜底并打 warn: CORE_MODEL_SNAPSHOT_MISSING。
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
SKILL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_core_models as cm  # noqa: E402


def row(category, model_id, *, active=True, anomaly=True, secondary="电脑办公", tags=None, src=None):
    return {
        "category": category, "secondary_category": secondary,
        "model_id": model_id, "model_name": f"m-{model_id}",
        "active": active, "anomaly_enabled": anomaly,
        "tags": tags or [], "source_row_numbers": src or [],
    }


class PlaceholderSnapshotTests(unittest.TestCase):
    def test_packaged_placeholder_exists_and_is_empty_pending(self):
        snap = cm.load_core_models(SKILL_ROOT / "references" / "process" / "core-models.json")
        self.assertEqual(snap.get("rows"), [])
        self.assertEqual(snap.get("status"), "pending_business_sheet")
        self.assertFalse(cm.snapshot_is_usable(snap))

    def test_missing_file_returns_missing_status(self):
        snap = cm.load_core_models(Path(tempfile.gettempdir()) / "nonexistent-core-models.json")
        self.assertEqual(snap.get("status"), "missing")
        self.assertEqual(snap.get("rows"), [])
        self.assertFalse(cm.snapshot_is_usable(snap))


class ActiveCoreModelsTests(unittest.TestCase):
    def test_groups_active_models_only_for_requested_categories(self):
        snap = {"status": "ok", "rows": [
            row("组装机", "1001"),
            row("组装机", "1002", active=False),   # 非 active 不进主指标
            row("显卡", "2001"),
            row("台球杆", "3001"),                 # 不在请求名单
        ]}
        out = cm.active_core_models_by_category(snap, ["组装机", "显卡"])
        self.assertEqual(set(out), {"组装机", "显卡"})
        self.assertEqual([m["model_id"] for m in out["组装机"]], ["1001"])
        self.assertEqual([m["model_id"] for m in out["显卡"]], ["2001"])

    def test_empty_snapshot_yields_empty_mapping(self):
        self.assertEqual(cm.active_core_models_by_category({"rows": []}, ["组装机"]), {})


class ValidateSnapshotTests(unittest.TestCase):
    TAXO = {"组装机", "显卡", "无人机"}

    def test_rejects_missing_or_invalid_model_id(self):
        rows = [row("组装机", ""), row("组装机", None), row("组装机", "1001")]
        normalized, report = cm.validate_core_models_rows(rows, self.TAXO)
        self.assertEqual([r["model_id"] for r in normalized], ["1001"])
        self.assertEqual(len(report["rejected_invalid_model_id"]), 2)

    def test_flags_category_not_in_taxonomy(self):
        rows = [row("不存在品类", "9001")]
        normalized, report = cm.validate_core_models_rows(rows, self.TAXO)
        self.assertEqual(normalized, [])
        self.assertIn("不存在品类", report["out_of_taxonomy"])

    def test_merges_tags_for_same_category_model_and_keeps_row_numbers(self):
        rows = [
            row("组装机", "1001", tags=["高端"], src=[3]),
            row("组装机", "1001", tags=["热销"], src=[7]),
        ]
        normalized, report = cm.validate_core_models_rows(rows, self.TAXO)
        self.assertEqual(len(normalized), 1)
        self.assertEqual(sorted(normalized[0]["tags"]), ["热销", "高端"])
        self.assertEqual(sorted(normalized[0]["source_row_numbers"]), [3, 7])
        self.assertEqual(report["merged_duplicates"], 1)

    def test_same_model_id_across_categories_is_conflict(self):
        rows = [row("组装机", "1001"), row("显卡", "1001")]
        normalized, report = cm.validate_core_models_rows(rows, self.TAXO)
        self.assertTrue(any(c["model_id"] == "1001" for c in report["conflicts"]))


class ParseFeishuRowsTests(unittest.TestCase):
    def test_maps_columns_and_yes_no_flags_with_row_numbers(self):
        records = [{
            "品类": "组装机", "二级类目": "电脑办公",
            "机型ID": "1001", "机型名称": "台式主机A",
            "是否核心观测机型": "是", "是否用于异动分析": "否",
            "关注理由": "头部机型", "负责人": "张三", "标签": "高端,热销",
        }]
        rows = cm.parse_feishu_core_model_rows(records)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["category"], "组装机")
        self.assertEqual(r["model_id"], "1001")
        self.assertTrue(r["active"])
        self.assertFalse(r["anomaly_enabled"])
        self.assertEqual(sorted(r["tags"]), ["热销", "高端"])
        self.assertEqual(r["source_row_numbers"], [1])

    def test_accepts_custom_column_map(self):
        records = [{"cat": "显卡", "mid": "2001", "core": "Y"}]
        cmap = {"category": "cat", "model_id": "mid", "active": "core"}
        rows = cm.parse_feishu_core_model_rows(records, column_map=cmap, truthy=("Y",))
        self.assertEqual(rows[0]["category"], "显卡")
        self.assertEqual(rows[0]["model_id"], "2001")
        self.assertTrue(rows[0]["active"])


class SyncBuildSnapshotTests(unittest.TestCase):
    def test_build_snapshot_validates_and_versions(self):
        import sync_core_models as sync
        records = [
            {"品类": "组装机", "机型ID": "1001", "是否核心观测机型": "是"},
            {"品类": "组装机", "机型ID": "", "是否核心观测机型": "是"},   # 非法 model_id 拒绝
            {"品类": "不在taxo", "机型ID": "9999", "是否核心观测机型": "是"},  # 品类不在 taxonomy
        ]
        snap = sync.build_snapshot(records, {"组装机", "显卡"}, version="1.2.3")
        self.assertEqual(snap["version"], "1.2.3")
        self.assertEqual(snap["status"], "ok")
        self.assertEqual([r["model_id"] for r in snap["rows"]], ["1001"])
        self.assertEqual(len(snap["sync_report"]["rejected_invalid_model_id"]), 1)
        self.assertIn("不在taxo", snap["sync_report"]["out_of_taxonomy"])

    def test_empty_records_stay_pending(self):
        import sync_core_models as sync
        snap = sync.build_snapshot([], {"组装机"}, version="1.0.0")
        self.assertEqual(snap["status"], "pending_business_sheet")
        self.assertEqual(snap["rows"], [])

    def test_cross_category_conflict_marks_status_conflict(self):
        import sync_core_models as sync
        records = [
            {"品类": "组装机", "机型ID": "1001", "是否核心观测机型": "是"},
            {"品类": "显卡", "机型ID": "1001", "是否核心观测机型": "是"},  # 同 model_id 跨品类冲突
        ]
        snap = sync.build_snapshot(records, {"组装机", "显卡"}, version="1.0.0")
        self.assertEqual(snap["status"], "conflict")
        self.assertTrue(snap["sync_report"]["conflicts"])


class SyncMainWriteGateTests(unittest.TestCase):
    def _write_input(self, tmp, records):
        import json as _json
        p = Path(tmp) / "in.json"
        p.write_text(_json.dumps(records), encoding="utf-8")
        return p

    def _taxo(self, tmp):
        import json as _json
        p = Path(tmp) / "taxo.json"
        p.write_text(_json.dumps({"rows": [{"category": "组装机"}, {"category": "显卡"}]}), encoding="utf-8")
        return p

    def test_main_refuses_to_write_on_conflict_without_force(self):
        import sync_core_models as sync
        conflict = [
            {"品类": "组装机", "机型ID": "1001", "是否核心观测机型": "是"},
            {"品类": "显卡", "机型ID": "1001", "是否核心观测机型": "是"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "core-models.json"
            argv = ["sync", "--input", str(self._write_input(tmp, conflict)),
                    "--taxonomy", str(self._taxo(tmp)), "--out", str(out)]
            with mock.patch.object(sys, "argv", argv):
                rc = sync.main()
            self.assertNotEqual(rc, 0)
            self.assertFalse(out.exists(), "冲突时禁止落盘（设计 §6.3 拒绝升级快照）")

    def test_main_writes_conflict_snapshot_with_force(self):
        import sync_core_models as sync
        conflict = [
            {"品类": "组装机", "机型ID": "1001", "是否核心观测机型": "是"},
            {"品类": "显卡", "机型ID": "1001", "是否核心观测机型": "是"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "core-models.json"
            argv = ["sync", "--input", str(self._write_input(tmp, conflict)),
                    "--taxonomy", str(self._taxo(tmp)), "--out", str(out), "--force"]
            with mock.patch.object(sys, "argv", argv):
                rc = sync.main()
            self.assertEqual(rc, 0)
            self.assertTrue(out.exists())


if __name__ == "__main__":
    unittest.main()
