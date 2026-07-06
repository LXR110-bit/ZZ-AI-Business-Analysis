"""CLI 输入 Pydantic 模型."""
from __future__ import annotations
from datetime import date
from pydantic import BaseModel, Field


class PipelineParams(BaseModel):
    weeks: list[str] | None = Field(default=None, description="目标 ISO 周, 例 2026-W27. 默认[上周,本周]")
    lookback_days: int = Field(default=14, description="IMAP 邮件回溯窗口(天)")
    skip_notify: bool = Field(default=False, description="跳过群通知(dry-run/回填)")
