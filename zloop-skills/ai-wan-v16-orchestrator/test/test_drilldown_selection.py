"""任务A：Loop1 侧确定性下钻名单选择逻辑。

名单 = 发展+孵化(always_floor) ∪ 种子异动(wow_anomaly, gmv 环比绝对变化超阈值) ∪ AI补充(先留空)
交接单 model_enrichment_mode：有名单 → enabled，空 → disabled(与阶段A过渡态一致)。
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_loop1_tick as tick  # noqa: E402

from test_loop1_tick import FakeAdapter, FakeJobClient, make_args  # noqa: E402


def ev_item(category, tier, secondary, gmv_delta, gmv_delta_pct, direction="down"):
    return {
        "category": category,
        "tier": tier,
        "secondaryCategory": secondary,
        "direction": direction,
        "delta": {"gmv_delta": gmv_delta, "gmv_delta_pct": gmv_delta_pct},
    }


class SelectDrilldownCategoriesTests(unittest.TestCase):
    def test_develop_and_incubate_tiers_always_floor_regardless_of_movement(self):
        pack = {"category_all": [
            ev_item("组装机", "发展", "电脑办公", -50000, -0.15),
            ev_item("显卡", "孵化", "电脑办公", 200, 0.001),  # 几乎没动，仍进
        ]}
        out = tick.select_drilldown_categories(pack)
        cats = {e["category"]: e for e in out}
        self.assertEqual(set(cats), {"组装机", "显卡"})
        self.assertEqual(cats["组装机"]["reason"], "always_floor")
        self.assertEqual(cats["显卡"]["reason"], "always_floor")

    def test_seed_included_only_when_gmv_wow_exceeds_threshold(self):
        pack = {"category_all": [
            ev_item("种子A", "种子", "电脑办公", -80000, -0.22),  # 超阈值 → 进
            ev_item("种子B", "种子", "电脑办公", -100, -0.03),    # 未超阈值 → 不进
        ]}
        out = tick.select_drilldown_categories(pack)
        cats = {e["category"]: e for e in out}
        self.assertEqual(set(cats), {"种子A"})
        self.assertEqual(cats["种子A"]["reason"], "wow_anomaly")
        self.assertEqual(cats["种子A"]["moved_metrics"], ["gmv"])

    def test_seed_positive_movement_also_counts_as_anomaly(self):
        pack = {"category_all": [ev_item("种子C", "种子", "手机通讯", 90000, 0.30, direction="up")]}
        out = tick.select_drilldown_categories(pack)
        self.assertEqual([e["category"] for e in out], ["种子C"])
        self.assertEqual(out[0]["reason"], "wow_anomaly")
        self.assertEqual(out[0]["direction"], "up")

    def test_none_pct_seed_is_not_selected(self):
        # 环比无法计算(prev=0)时 pct 为 None，不当作 gmv 异动
        pack = {"category_all": [ev_item("种子D", "种子", "手机通讯", 90000, None)]}
        self.assertEqual(tick.select_drilldown_categories(pack), [])

    def test_entry_shape_has_required_keys(self):
        pack = {"category_all": [ev_item("组装机", "发展", "电脑办公", -50000, -0.15)]}
        entry = tick.select_drilldown_categories(pack)[0]
        for key in ("category", "tier", "reason", "moved_metrics"):
            self.assertIn(key, entry)

    def test_empty_evidence_yields_empty_list(self):
        self.assertEqual(tick.select_drilldown_categories({}), [])
        self.assertEqual(tick.select_drilldown_categories({"category_all": []}), [])

    def test_dedup_by_category(self):
        pack = {"category_all": [
            ev_item("组装机", "发展", "电脑办公", -50000, -0.15),
            ev_item("组装机", "发展", "电脑办公", -10, -0.001),
        ]}
        self.assertEqual(len(tick.select_drilldown_categories(pack)), 1)

    def test_falls_back_to_category_top_changes(self):
        pack = {"category_top_changes": [ev_item("组装机", "发展", "电脑办公", -50000, -0.15)]}
        self.assertEqual([e["category"] for e in tick.select_drilldown_categories(pack)], ["组装机"])


class EnsureDrilldownHandoffModeTests(unittest.TestCase):
    def test_empty_list_keeps_disabled_mode(self):
        jobs = FakeJobClient()
        args = make_args()
        handoff = tick.ensure_drilldown_handoff(jobs, args)
        self.assertEqual(handoff["model_enrichment_mode"], "disabled")
        self.assertEqual(handoff["drilldown_categories"], [])

    def test_non_empty_list_enables_and_persists_categories(self):
        jobs = FakeJobClient()
        args = make_args()
        drill = [{"category": "组装机", "tier": "发展", "reason": "always_floor", "moved_metrics": ["gmv"]}]
        handoff = tick.ensure_drilldown_handoff(jobs, args, drilldown_categories=drill)
        self.assertEqual(handoff["model_enrichment_mode"], "enabled")
        self.assertEqual(handoff["drilldown_categories"], drill)


class FinalizeWritesDrilldownListTests(unittest.TestCase):
    DISPLAY = {
        "board": "大盘风险等级中等，链路上下单到发货承压，拖累来自组装机，下一步验证下单转化。",
        "category": "全局品类概览：以组装机为主。",
        "monitor": "监测：关注组装机口径稳定性。",
        "tiers": {
            "发展": "发展层风险集中，成交GMV下降，需下钻验证。",
            "孵化": "孵化层机会，成交订单提升，观察下单率。",
            "种子": "种子层风险，成交率波动，先验证口径。",
        },
        "secondaryCategories": {"电脑办公": "电脑办公板块贡献，链路看下单到发货。"},
        "categories": {
            "组装机": "组装机属于高影响风险品类，成交GMV下降需下钻。",
            "种子B": "种子B属于稳健品类，成交GMV波动小，持续观察。",
        },
    }
    EVIDENCE = {"category_all": [
        ev_item("组装机", "发展", "电脑办公", -50000, -0.15),
        ev_item("种子B", "种子", "电脑办公", -100, -0.03),
    ]}

    def _setup_run_dir(self, run_dir):
        (run_dir / tick.ANALYSIS_RESULT_FILE).write_text(
            json.dumps({"display_insights": self.DISPLAY}, ensure_ascii=False), encoding="utf-8")
        (run_dir / tick.ANALYSIS_SCAFFOLD_FILE).write_text(
            json.dumps({"evidence_pack": self.EVIDENCE, "findings": [],
                        "display_contract": tick.core.DISPLAY_CONTRACT, "history_weeks": 2,
                        "analysis_scope": "wow_only"}, ensure_ascii=False), encoding="utf-8")
        (run_dir / tick.PROCESSED_RESULT_FILE).write_text(
            json.dumps({"status": "success"}, ensure_ascii=False), encoding="utf-8")

    def test_finalize_selects_floor_categories_and_enables_mode(self):
        jobs = FakeJobClient()
        args = make_args()
        jobs.job = {
            "job_id": f"base:{args.analysis_key}:b1:h0", "analysis_key": args.analysis_key,
            "base_revision": 1, "state_revision": 5, "status": "validating",
            "current_stage": "analyze", "sql_checkpoints": {}, "execute_ids": {},
            "lease_owner": args.worker_id, "lease_expires_at": "2999-01-01T00:00:00.000Z",
        }
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            run_dir = tick.core.out_root() / "aiwan_runs" / args.run_id
            run_dir.mkdir(parents=True, exist_ok=True)
            self._setup_run_dir(run_dir)
            job = json.loads(json.dumps(jobs.job))
            result = tick.finalize_after_analyze(args, run_dir, job, jobs, FakeAdapter())
        self.assertEqual(result["business_status"], "published")
        handoff = jobs.handoff
        self.assertEqual(handoff["model_enrichment_mode"], "enabled")
        cats = {e["category"]: e for e in handoff["drilldown_categories"]}
        self.assertEqual(set(cats), {"组装机"})  # 发展进；种子B 未超阈值不进
        self.assertEqual(cats["组装机"]["reason"], "always_floor")


if __name__ == "__main__":
    unittest.main()
