"""Loop2 server seam wiring: model CSV parser, base display read, model validate write."""
import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_inline_state_machine as core  # noqa: E402


class FakeResponse:
    def __init__(self, data, ok=True, status_code=200):
        self._data = data
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self._data


class FakeHub:
    def __init__(self):
        self.posts = []
        self.revision = 7
        self.display = {
            "board": "大盘文本", "category": "品类概览", "monitor": "监测说明",
            "tiers": {"发展": "发展文本", "孵化": "孵化文本", "种子": "种子文本"},
            "secondaryCategories": {},
            "categories": {"组装机": "Loop1 组装机文本"},
        }

    def post(self, path, json_body=None, timeout=90.0):
        self.posts.append((path, json.loads(json.dumps(json_body or {}))))
        if path == core.READ_PATH:
            return FakeResponse({
                "ok": True,
                "run_id": (json_body or {}).get("run_id"),
                "current_output": {
                    "run_id": (json_body or {}).get("run_id"),
                    "revision": self.revision,
                    "output_type": "validation_result",
                },
                "context": {"metric_snapshot": {
                    "analysisStatus": {
                        "analysis_key": "2026-W29:2026-07-16",
                        "data_end_date": "2026-07-16",
                        "base_revision": 3,
                        "model_enrichment_mode": "enabled",
                    },
                    "insights": self.display,
                }},
            })
        if path == core.WRITE_PATH:
            self.display = json_body["payload"]["analysis_result"]["display_insights"]
            return FakeResponse({"ok": True, "revision": self.revision})
        return FakeResponse({"ok": False, "error": "bad path"}, ok=False, status_code=404)


def make_args():
    return argparse.Namespace(
        run_id="loop2-seam-test", week="2026-W29", run_dt="2026-07-17",
        data_end_date="2026-07-16", analysis_key="2026-W29:2026-07-16",
        base_revision=3,
    )


class Loop2ServerSeamTests(unittest.TestCase):
    def test_load_model_rows_for_categories_computes_latest_week_deltas(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            exports = run_dir / "read_exports"
            exports.mkdir()
            (exports / "model_summary_2026-07-17.csv").write_text(
                "week_start_date,品类名称,机型ID,机型名称,估价uv,下单uv,下单量,发货量,成交量,成交GMV\n"
                "2026-07-06,组装机,1001,主机A,100,40,30,20,10,10000\n"
                "2026-07-13,组装机,1001,主机A,120,30,20,12,5,7000\n"
                "2026-07-13,手机,9999,手机X,120,30,20,12,5,7000\n",
                encoding="utf-8",
            )
            rows = core.load_model_rows_for_categories(run_dir, [{"category": "组装机"}])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category"], "组装机")
        self.assertEqual(rows[0]["model_id"], "1001")
        self.assertEqual(rows[0]["gmv"], 7000)
        self.assertEqual(rows[0]["gmv_delta"], -3000)
        self.assertAlmostEqual(rows[0]["gmv_delta_pct"], -0.3)

    def test_read_published_display_uses_aiwan_read_bridge(self):
        hub = FakeHub()
        with mock.patch.object(core, "hub", hub):
            display = core.read_published_display(make_args())
        self.assertEqual(display["categories"]["组装机"], "Loop1 组装机文本")
        self.assertEqual(hub.posts[-1][0], core.READ_PATH)
        self.assertEqual(hub.posts[-1][1]["include"], ["metric_snapshot"])

    def test_execute_model_validate_writes_and_rereads_model_drilldowns(self):
        hub = FakeHub()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(core, "hub", hub):
            run_dir = Path(tmp)
            core.write_json(run_dir / "processed_models.json", {"status": "success", "week": args.week})
            merged = {
                **hub.display,
                "modelDrilldowns": {"组装机": {"summary": "1001 贡献主要变化", "models": []}},
            }
            result = core.execute_model_validate(args, run_dir, merged)
            saved = core.read_json(run_dir / "model_validation_result.json")
        self.assertTrue(result["server_write_confirmed"])
        self.assertTrue(saved["server_write_confirmed"])
        write_body = [body for path, body in hub.posts if path == core.WRITE_PATH][0]
        self.assertEqual(write_body["expected_base_revision"], 3)
        self.assertEqual(write_body["payload"]["analysis_result"]["display_insights"]["modelDrilldowns"], merged["modelDrilldowns"])


if __name__ == "__main__":
    unittest.main()
