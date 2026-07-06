"""月度 sheets/tab schema/邮件常量."""
from __future__ import annotations
from datetime import date

# --- 所有 tab 共通的维度列 (跟机型 1:1 的属性, group by 不改变粒度) ---
COMMON_DIMS = ["品类名称"]

# --- 通用 tab schema (sheet_id → extra_dims/metrics) ---
# 汇总表 & 日均表都用这套 sheet_id (用户复制模板保留 id 一致)
INTERMEDIATE_TABS = {
    "6725f1": {
        "name": "日期机型维度",
        "extra_dims": [],
        "metrics": ["机况UV", "估价UV", "下单UV", "下单量", "发货量", "签收量", "质检量", "成交量", "退回量", "成交GMV"],
    },
    "7rBBpo": {
        "name": "机型核心属性成色",
        "extra_dims": ["核心属性（估价）", "成色等级（估价）"],
        "metrics": ["估价UV", "下单UV", "下单量", "发货量", "签收量", "质检量", "成交量", "退回量", "成交GMV"],
    },
    "053Pci": {
        "name": "机型履约",
        "extra_dims": ["履约方式（只取线上流程）"],
        "metrics": ["估价UV", "下单UV", "下单量", "发货量", "签收量", "质检量", "成交量", "退回量", "成交GMV"],
    },
    "VsIzPj": {
        "name": "机型核心属性成色履约",
        "extra_dims": ["核心属性（估价）", "成色等级（估价）", "履约方式（只取线上流程）"],
        "metrics": ["估价UV", "下单UV", "下单量", "发货量", "签收量", "质检量", "成交量", "退回量", "成交GMV"],
    },
    "B0ZJKk": {
        "name": "机型质检成交",
        "extra_dims": ["核心属性（质检）", "成色等级（质检）"],
        "metrics": ["质检量", "成交量", "退回量", "成交GMV"],
    },
}

# --- 汇总表 (仅 7-12 月) ---
SUMMARY_TOKENS = {
    "2026-05": "LIIns3sJbhgbJMtV3D9cGSqqn0e",
    "2026-06": "TzkVs1LVshLaZjtH1nzcG4opnxb",
    "2026-07": "ZXensHZChhHgqztgg2Bc28Cwnad",
    "2026-08": "B5ZEsVFiphj3A8t2tCmcvOFFnTe",
    "2026-09": "GaIFsSFmThmcfQtDR1dcf7bvnXg",
    "2026-10": "LszOsCQXch7i1Xt7mascwDfHnSe",
    "2026-11": "HO14sff3LhaadotFVqDczUVQn5c",
    "2026-12": "TYARsAHZThSXLqtKHPYc2KAWnQj",
}

# --- 日均表 (1-12 月) ---
DAILY_AVG_TOKENS = {
    "2026-01": "KkIbsetvdhj9NPthsGrc3qWvncf",
    "2026-02": "XdPvsdqfEh6V5atdCwOc4iVWn6f",
    "2026-03": "CesTso9DxhkSCJthsNYcHyGVnbe",
    "2026-04": "XOtfs184QhMqyBtPtV2cwxuPnOf",
    "2026-05": "EsNysn5CXhI6bdtMLXfcu4jznxe",
    "2026-06": "FRxvsYBZWhsN7QtXGFMc7WOVnyb",
    "2026-07": "T99nsHjgThiR13tD6ofc0ql5nQQ",
    "2026-08": "EGHQscanphErGntcNcicoyfYnnf",
    "2026-09": "QJiMs9piehzJBStzT4Kc1HcWnOC",
    "2026-10": "LAczsXQ2ihRfhttDtIfc0TLtnTh",
    "2026-11": "Vlo3sJzDYhooANtikmOcKRFqnuh",
    "2026-12": "GUpbslb5WhjVrYtxPazc5gxunkc",
}

# 汇总表 tab sheet_id (5 tab, 同 INTERMEDIATE_TABS key)
SUMMARY_SHEET_IDS = list(INTERMEDIATE_TABS.keys())  # 6725f1/7rBBpo/053Pci/VsIzPj/B0ZJKk

# 日均表 tab sheet_id 不同! (用户复制自另一份模板)
# 汇总 sheet_id → 日均 sheet_id 映射
SUMMARY_TO_DAILY_AVG_SID = {
    "6725f1": "e2676a",  # 日期机型维度
    "7rBBpo": "oVpEk4",  # 机型核心属性成色
    "053Pci": "1HcKTj",  # 机型履约
    "VsIzPj": "ulcnkm",  # 机型核心属性成色履约
    "B0ZJKk": "F2h1jv",  # 机型质检成交
}

# --- 邮件 ---
EMAIL_SUBJECT = "AI小万_机型漏斗数据"

# --- 群通知 ---
CHAT_ID_ENV = "WEEKLY_REPORT_CHAT_ID"

# --- xlsx 列名 → 标准列名映射 (小写→大写, 括号里"估价"保留) ---
XLSX_TO_INTERMEDIATE_HEADER = {
    "日期": "日期",
    "机型id": "机型ID",
    "机型名称": "机型名称",
    "品类名称": "品类名称",
    "核心属性（估价）": "核心属性（估价）",
    "成色等级（估价）": "成色等级（估价）",
    "核心属性（质检）": "核心属性（质检）",
    "成色等级（质检）": "成色等级（质检）",
    "履约方式（只取线上流程）": "履约方式（只取线上流程）",
    "机况uv": "机况UV",
    "估价uv": "估价UV",
    "下单uv": "下单UV",
    "下单量": "下单量",
    "发货量": "发货量",
    "签收量": "签收量",
    "质检量": "质检量",
    "成交量": "成交量",
    "退回量": "退回量",
    "成交gmv": "成交GMV",
}


def month_key(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def summary_token_for(d: date) -> str | None:
    return SUMMARY_TOKENS.get(month_key(d))


def daily_avg_token_for(d: date) -> str | None:
    return DAILY_AVG_TOKENS.get(month_key(d))


# --- 日均表主链接 (群通知用当月) ---
DAILY_AVG_WIKI_URL_TMPL = "https://zhuanspirit.feishu.cn/wiki/"
# wiki node_token → 传给 notifier;这里只存兜底的 6 月 (老 sheets)
DAILY_AVG_WIKI_NODES = {
    "2026-01": "SxTGwIuHViWUMRkP9CpcoZpAnQe",
    "2026-02": "AqMIwIF0ciIVwMkeLMIcHQbQnYd",
    "2026-03": "PZOiwnmYDi1sWekvKuBcobdlnZb",
    "2026-04": "OJcewcVRViHmxzkf3cfcLNXGnTg",
    "2026-05": "DiunwFXETir06hkFSjWc5cXlnPh",
    "2026-06": "UzEZwrOTVimV0RkjOaBcT4EWnGf",
    "2026-07": "SgJewTJz9iN8hXkNe6McA0Afnih",
    "2026-08": "Dln3wOkpWiMxFvkYz7fcWxSLn9e",
    "2026-09": "IM3Hw4eDoihr2Vkp2QTcVyejnAd",
    "2026-10": "KsdlwbE3yiwQP3kvjSEccsFHnde",
    "2026-11": "PvfdwV0rCiuDq2kQ7XRcmW43nif",
    "2026-12": "XFtTw5mIriIYeRkAgD2cgMu5n7f",
}
