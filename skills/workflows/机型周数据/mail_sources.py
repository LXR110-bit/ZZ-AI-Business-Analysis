"""Six-mail input contract for the online local CSV workflow."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MailSource:
    source_key: str
    subject_contains: str
    filename_prefix: str
    # role controls downstream consumption priority; required controls mailbox completeness.
    # backup files are still required because they support validation, rollback, and future consumers.
    role: str
    required: bool = True

    def output_filename(self, month: str) -> str:
        if len(month) != 7 or month[4] != "-":
            raise ValueError(f"month must be YYYY-MM, got {month!r}")
        return f"{self.filename_prefix}_{month}.csv"


MAIL_SOURCES: tuple[MailSource, ...] = (
    MailSource("category_daily_avg", "AI小万_品类漏斗数据周日均", "category_daily_avg", "primary"),
    MailSource("model_summary", "AI小万_机型漏斗数据周汇", "model_summary", "backup"),
    MailSource("category_summary", "AI小万_品类漏斗数据周汇", "category_summary", "backup"),
    MailSource("model_daily_avg", "AI小万_机型漏斗数据周日均", "model_daily_avg", "primary"),
    MailSource("category_fulfill_daily_avg", "AI小万_品类履约漏斗数据周日均", "category_fulfill_daily_avg", "primary"),
    MailSource("category_fulfill_summary", "AI小万_品类履约漏斗数据周汇", "category_fulfill_summary", "backup"),
)


def required_sources() -> list[MailSource]:
    return [source for source in MAIL_SOURCES if source.required]


def source_by_key(source_key: str) -> MailSource:
    for source in MAIL_SOURCES:
        if source.source_key == source_key:
            return source
    raise KeyError(f"unknown mail source_key: {source_key}")


def missing_required_sources(present_source_keys: set[str]) -> list[MailSource]:
    return [source for source in required_sources() if source.source_key not in present_source_keys]
