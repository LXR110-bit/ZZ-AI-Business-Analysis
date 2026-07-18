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


if __name__ == "__main__":
    unittest.main()
