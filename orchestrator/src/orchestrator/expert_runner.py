"""调用 codex exec 启动专家子进程。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

WORKSPACE_ROOT = Path("/root/workspace/ZZ-AI-Business-Analysis")
EXPERTS_DIR = WORKSPACE_ROOT / "experts"


def run_expert(expert_id: str, prompt: str, timeout: int = 600) -> dict:
    """启动 codex exec 子进程，让指定专家处理问题。

    返回 {ok, stdout, stderr, exit_code, duration_sec}。
    """
    expert_dir = EXPERTS_DIR / expert_id
    if not expert_dir.is_dir():
        return {"ok": False, "error": f"专家目录不存在: {expert_dir}"}

    cmd = [
        "codex", "exec",
        "--skip-git-repo-check",
        "--cd", str(expert_dir),
        prompt,
    ]
    import time
    t0 = time.time()
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        env={**os.environ},
    )
    return {
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "duration_sec": round(time.time() - t0, 1),
        "expert_id": expert_id,
        "expert_dir": str(expert_dir),
    }
