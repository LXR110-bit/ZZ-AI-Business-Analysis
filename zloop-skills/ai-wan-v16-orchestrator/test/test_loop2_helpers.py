"""任务B（第一波）：Loop2 纯函数——SQL 品类过滤注入、候选机型收敛、增量 merge。"""
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_loop2_tick as loop2  # noqa: E402


class InjectCategoryFilterTests(unittest.TestCase):
    SQL = (
        "select a.cate_name, a.model_id\n"
        "from t a\n"
        "where a.dt        between date_sub(next_day(date_sub('2026-07-16', 7), 'MON'),7) and '2026-07-16'\n"
        "  and a.stat_date between date_sub(next_day(date_sub('2026-07-16', 7), 'MON'),7) and '2026-07-16'\n"
        "group by a.cate_name, a.model_id\n"
    )

    def test_injects_in_clause_after_stat_date_where(self):
        out = loop2.inject_category_filter(self.SQL, ["组装机", "显卡"])
        self.assertIn("a.cate_name in ('组装机','显卡')", out)
        # 注入在 stat_date where 之后、group by 之前
        self.assertLess(out.index("a.cate_name in"), out.index("group by"))

    def test_escapes_single_quotes(self):
        out = loop2.inject_category_filter(self.SQL, ["it's"])
        self.assertIn("'it''s'", out)

    def test_empty_categories_returns_unchanged(self):
        self.assertEqual(loop2.inject_category_filter(self.SQL, []), self.SQL)

    def test_does_not_match_comment_lines(self):
        sql = "--   and a.stat_date between x and '2026-07-16'\n" + self.SQL
        out = loop2.inject_category_filter(sql, ["组装机"])
        # 只注入 1 处（真实 where），注释行不注入
        self.assertEqual(out.count("a.cate_name in ('组装机')"), 1)

    def test_real_model_sql_gets_filter(self):
        template = SCRIPT_DIR.parent / "references" / "read" / "sql" / "model_summary.sql"
        rendered = loop2.core.render_sql(template.read_text(encoding="utf-8"), "2026-07-16", "2026-07-16")
        out = loop2.inject_category_filter(rendered, ["组装机"])
        self.assertIn("a.cate_name in ('组装机')", out)

    def test_raises_when_no_where_matched(self):
        # 模板结构变了、一处都没注入 → 报错，绝不静默退化成全品类扫描
        sql = "select a.cate_name from t group by a.cate_name\n"
        with self.assertRaises(RuntimeError):
            loop2.inject_category_filter(sql, ["组装机"])


def m(category, model_id, gmv, gmv_delta_pct=0.0):
    return {"category": category, "model_id": model_id, "model_name": f"m{model_id}",
            "gmv": gmv, "gmv_delta": gmv * (gmv_delta_pct or 0), "gmv_delta_pct": gmv_delta_pct}


class SelectCandidateModelsTests(unittest.TestCase):
    def test_union_of_core_topn_and_anomaly_with_reasons(self):
        rows = [
            m("组装机", "1", 1000), m("组装机", "2", 900), m("组装机", "3", 800),
            m("组装机", "4", 700), m("组装机", "5", 600), m("组装机", "6", 10, gmv_delta_pct=-0.5),
        ]
        core = {"组装机": [{"model_id": "9", "model_name": "核心9"}]}
        by_cat, warnings = loop2.select_candidate_models(rows, core_models=core, top_n=3, anomaly_cap=5)
        models = {x["model_id"]: x for x in by_cat["组装机"]["models"]}
        # top3(1,2,3) ∪ anomaly(6) ∪ core(9)
        self.assertEqual(set(models), {"1", "2", "3", "6", "9"})
        self.assertIn("gmv_top5", models["1"]["selection_reasons"])
        self.assertIn("anomaly", models["6"]["selection_reasons"])
        self.assertIn("core", models["9"]["selection_reasons"])
        self.assertEqual(warnings, [])

    def test_core_reason_unions_when_core_also_in_topn(self):
        rows = [m("组装机", "1", 1000)]
        core = {"组装机": [{"model_id": "1", "model_name": "m1"}]}
        by_cat, _ = loop2.select_candidate_models(rows, core_models=core, top_n=5)
        reasons = by_cat["组装机"]["models"][0]["selection_reasons"]
        self.assertIn("core", reasons)
        self.assertIn("gmv_top5", reasons)

    def test_anomaly_over_cap_goes_to_truncated(self):
        rows = [m("组装机", str(i), 10, gmv_delta_pct=-0.5 - i / 100) for i in range(8)]
        by_cat, _ = loop2.select_candidate_models(rows, core_models={}, top_n=0, anomaly_cap=5)
        self.assertEqual(len(by_cat["组装机"]["models"]), 5)
        self.assertEqual(len(by_cat["组装机"]["truncated_candidates"]), 3)

    def test_missing_core_snapshot_emits_warning(self):
        rows = [m("组装机", "1", 1000)]
        by_cat, warnings = loop2.select_candidate_models(rows, core_models=None)
        self.assertIn("CORE_MODEL_SNAPSHOT_MISSING", warnings)

    def test_dedup_by_category_and_model(self):
        rows = [m("组装机", "1", 1000, gmv_delta_pct=-0.6)]  # 同时命中 top 和 anomaly
        by_cat, _ = loop2.select_candidate_models(rows, core_models={}, top_n=5, anomaly_cap=5)
        self.assertEqual(len(by_cat["组装机"]["models"]), 1)
        self.assertEqual(set(by_cat["组装机"]["models"][0]["selection_reasons"]), {"gmv_top5", "anomaly"})

    def test_restricts_to_requested_categories(self):
        # SQL 过滤若失效导致 CSV 混入非下钻品类，也只对下钻名单收敛（兜底）
        rows = [m("组装机", "1", 1000), m("显卡", "2", 900), m("台球杆", "3", 800)]
        by_cat, _ = loop2.select_candidate_models(rows, core_models={}, requested_categories=["组装机", "显卡"])
        self.assertEqual(set(by_cat), {"组装机", "显卡"})


class CoverageByCategoryTests(unittest.TestCase):
    """确定性覆盖度（设计 §7.3）：已归因机型 |ΔGMV| 之和 ÷ 品类全部机型 |ΔGMV| 之和。"""

    def _sel(self, model_ids):
        return {"models": [{"model_id": mid} for mid in model_ids], "truncated_candidates": []}

    def test_coverage_is_ratio_of_analyzed_over_total_abs_delta(self):
        rows = [
            {"category": "组装机", "model_id": "1", "gmv_delta": -80},
            {"category": "组装机", "model_id": "2", "gmv_delta": 10},
            {"category": "组装机", "model_id": "3", "gmv_delta": -10},
        ]
        by_cat = {"组装机": self._sel(["1"])}  # 只分析了 model 1
        cov = loop2.compute_coverage_by_category(by_cat, rows)
        # |−80| / (|−80|+|10|+|−10|) = 80/100 = 0.8
        self.assertAlmostEqual(cov["组装机"]["coverage"], 0.8)
        self.assertEqual(cov["组装机"]["attribution_status"], "sufficient")

    def test_below_threshold_is_insufficient_coverage(self):
        rows = [
            {"category": "组装机", "model_id": "1", "gmv_delta": -50},
            {"category": "组装机", "model_id": "2", "gmv_delta": -50},
        ]
        by_cat = {"组装机": self._sel(["1"])}  # 50/100 = 0.5 < 0.70
        cov = loop2.compute_coverage_by_category(by_cat, rows)
        self.assertAlmostEqual(cov["组装机"]["coverage"], 0.5)
        self.assertEqual(cov["组装机"]["attribution_status"], "insufficient_coverage")

    def test_no_model_rows_yields_unknown_not_fake_number(self):
        by_cat = {"组装机": self._sel(["1"])}
        cov = loop2.compute_coverage_by_category(by_cat, [])
        self.assertIsNone(cov["组装机"]["coverage"])
        self.assertEqual(cov["组装机"]["attribution_status"], "unknown")


class MergeModelDrilldownsTests(unittest.TestCase):
    def test_preserves_loop1_category_text_and_adds_top_level_field(self):
        display = {
            "board": "大盘...", "categories": {"组装机": "组装机属于高影响风险品类，成交GMV下降。"},
        }
        drill = {"组装机": {"status": "complete", "coverage": 0.8, "summary": "三个机型贡献主要降幅。", "models": []}}
        out = loop2.merge_model_drilldowns_into_display(display, drill)
        self.assertIn("modelDrilldowns", out)
        self.assertEqual(out["modelDrilldowns"], drill)
        # Loop1 原文保留
        self.assertIn("高影响风险品类", out["categories"]["组装机"])
        # 机型下钻摘要增量拼接
        self.assertIn("三个机型贡献主要降幅", out["categories"]["组装机"])

    def test_does_not_touch_board_or_tiers(self):
        display = {"board": "板块文本", "tiers": {"发展": "发展文本"}, "categories": {}}
        out = loop2.merge_model_drilldowns_into_display(display, {})
        self.assertEqual(out["board"], "板块文本")
        self.assertEqual(out["tiers"], {"发展": "发展文本"})

    def test_missing_category_card_is_not_created_from_drilldown(self):
        # Loop1 没写的品类卡片，Loop2 不凭空造（validate 写契约不变）
        display = {"categories": {}}
        drill = {"未知品类": {"summary": "x", "models": []}}
        out = loop2.merge_model_drilldowns_into_display(display, drill)
        self.assertNotIn("未知品类", out["categories"])


class GateModelDrilldownsTests(unittest.TestCase):
    """机器闸门：agent 写的 modelDrilldowns 必须覆盖候选品类、机型可追溯、证据分级齐全（§8.1/§8.3）。"""

    SCAFFOLD = {"candidate_models": {"组装机": {"models": [{"model_id": "1001"}, {"model_id": "2002"}]}}}

    def _dd(self, models):
        return {"组装机": {"summary": "摘要。", "models": models}}

    def test_valid_drilldown_passes(self):
        dd = self._dd([{"model_id": "1001", "facts": ["f"], "hypotheses": [], "data_gaps": []}])
        self.assertEqual(loop2.gate_model_drilldowns(dd, self.SCAFFOLD), [])

    def test_missing_category_flagged(self):
        self.assertIn("missing_drilldown:组装机", loop2.gate_model_drilldowns({}, self.SCAFFOLD))

    def test_empty_summary_flagged(self):
        dd = {"组装机": {"summary": "  ", "models": [{"model_id": "1001", "facts": [], "hypotheses": [], "data_gaps": []}]}}
        self.assertIn("empty_summary:组装机", loop2.gate_model_drilldowns(dd, self.SCAFFOLD))

    def test_empty_models_when_candidates_exist_flagged(self):
        self.assertIn("empty_models:组装机", loop2.gate_model_drilldowns(self._dd([]), self.SCAFFOLD))

    def test_model_id_not_in_candidates_flagged(self):
        dd = self._dd([{"model_id": "9999", "facts": [], "hypotheses": [], "data_gaps": []}])
        errs = loop2.gate_model_drilldowns(dd, self.SCAFFOLD)
        self.assertTrue(any(e.startswith("unknown_model:组装机:9999") for e in errs))

    def test_missing_evidence_levels_flagged(self):
        dd = self._dd([{"model_id": "1001", "facts": []}])  # 缺 hypotheses/data_gaps
        errs = loop2.gate_model_drilldowns(dd, self.SCAFFOLD)
        self.assertTrue(any(e.startswith("missing_evidence_levels:组装机:1001") for e in errs))

    def test_history_unavailable_forbids_multiweek_fields(self):
        scaffold = {
            **self.SCAFFOLD,
            "system_evidence": {"allow_multiweek_trend": False, "trend_by_category": {}},
        }
        dd = self._dd([{"model_id": "1001", "facts": [], "hypotheses": [], "data_gaps": [], "trend_status": "sustained_trend"}])
        errs = loop2.gate_model_drilldowns(dd, scaffold)
        self.assertTrue(any(e.startswith("history_unavailable_forbids_multiweek:组装机:1001") for e in errs))

    def test_agent_trend_status_must_match_system_evidence(self):
        scaffold = {
            **self.SCAFFOLD,
            "system_evidence": {
                "allow_multiweek_trend": True,
                "trend_by_category": {"组装机": {"1001": {"trend_status": "single_week_anomaly"}}},
            },
        }
        dd = self._dd([{"model_id": "1001", "facts": [], "hypotheses": [], "data_gaps": [], "trend_status": "sustained_trend"}])
        errs = loop2.gate_model_drilldowns(dd, scaffold)
        self.assertTrue(any(e.startswith("trend_status_mismatch:组装机:1001") for e in errs))


if __name__ == "__main__":
    unittest.main()
