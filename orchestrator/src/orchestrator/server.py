"""FastAPI webhook 入口（MVP-2 启用，MVP-1 占位）."""
from __future__ import annotations

import os

from fastapi import FastAPI, Request

from . import router
from .expert_runner import run_expert

app = FastAPI(title="ZZ Agent Orchestrator")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "version": "0.1.0"}


@app.post("/webhook/lark")
async def lark_webhook(request: Request) -> dict:
    """飞书事件回调入口（MVP-2 完整实现）."""
    payload = await request.json()
    # URL 验证
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}
    # MVP-1：先返回收到，不实际处理
    return {"ok": True, "received": payload.get("header", {}).get("event_type", "unknown")}


@app.post("/api/run")
async def run(request: Request) -> dict:
    """直接调用 agent（用于内部测试）."""
    body = await request.json()
    question = body.get("question", "").strip()
    if not question:
        return {"ok": False, "error": "question 必填"}

    expert_id, reason = router.route(question)
    result = run_expert(expert_id, question, timeout=600)
    return {
        "expert": expert_id,
        "reason": reason,
        **result,
    }
