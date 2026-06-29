"""扫描仓库里的所有 Skill 文件，解析 frontmatter，返回元数据列表。

约定：Skill 文件是 markdown，文件头是 YAML frontmatter，含 `name` 字段。

例：
    ---
    name: weekly_report
    description: 生成品类周报...
    trigger: 用户说 "X品类周报"...
    ---

    # 周报 Skill
    ...
"""
from __future__ import annotations

import yaml
from dataclasses import dataclass, field
from pathlib import Path


# 默认扫描的位置（兼容当前布局 + 未来 skills/ 顶层布局）
DEFAULT_SCAN_DIRS = (
    "experts",              # 当前布局: experts/<expert>/skills/<skill>.md
    "skills",               # 未来布局: skills/<category>/<skill>.md
)


@dataclass
class SkillMeta:
    """单个 Skill 的元数据."""
    name: str                                # frontmatter.name
    description: str                          # frontmatter.description
    trigger: str | None = None                # frontmatter.trigger
    category: str = "uncategorized"           # 由路径推断（如 process / implementation / daily_analyst）
    file_path: str = ""                        # 相对路径，用于 Codex 引用
    extra: dict = field(default_factory=dict)  # 其他 frontmatter 字段


def _parse_frontmatter(text: str) -> dict | None:
    """从 markdown 文本里抽 YAML frontmatter（用 --- 分隔）。

    不是合法 frontmatter 的返回 None。
    """
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    try:
        meta = yaml.safe_load(parts[1])
    except yaml.YAMLError:
        return None
    return meta if isinstance(meta, dict) else None


def _infer_category(rel_path: Path) -> str:
    """根据相对路径推断 category。

    experts/daily_analyst/skills/weekly_report.md → "daily_analyst"
    skills/process/weekly_report.md              → "process"
    skills/implementation/yoy.md                  → "implementation"
    其他                                            → "uncategorized"
    """
    parts = rel_path.parts
    if len(parts) >= 2 and parts[0] in ("skills",):
        return parts[1]
    if len(parts) >= 2 and parts[0] == "experts":
        return parts[1]
    return "uncategorized"


def load_skills(
    repo_root: Path | str,
    scan_dirs: tuple[str, ...] = DEFAULT_SCAN_DIRS,
) -> list[SkillMeta]:
    """扫描 repo 下指定目录，返回所有合法 Skill 的元数据列表。"""
    root = Path(repo_root).resolve()
    skills: list[SkillMeta] = []

    for d in scan_dirs:
        scan_root = root / d
        if not scan_root.is_dir():
            continue
        for md_file in scan_root.rglob("*.md"):
            if not md_file.is_file():
                continue
            # 跳过 README / SKILL_INDEX 之类元文档
            if md_file.name.lower() in {"readme.md", "index.md", "agents.md"}:
                continue
            try:
                text = md_file.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            meta = _parse_frontmatter(text)
            if not meta or "name" not in meta:
                continue
            rel = md_file.relative_to(root)
            skills.append(SkillMeta(
                name=str(meta["name"]).strip(),
                description=str(meta.get("description", "")).strip(),
                trigger=str(meta["trigger"]).strip() if "trigger" in meta else None,
                category=_infer_category(rel),
                file_path=str(rel),
                extra={k: v for k, v in meta.items() if k not in ("name", "description", "trigger")},
            ))

    # 按 name 排序，保证调用计划稳定
    skills.sort(key=lambda s: s.name)
    return skills
