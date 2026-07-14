#!/usr/bin/env bash
set -euo pipefail

echo "== host =="
hostname || true
uname -a
uname -m

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  echo "os=${PRETTY_NAME:-unknown}"
fi

echo "== time =="
timedatectl status 2>/dev/null || date -Iseconds

echo "== disks =="
df -h / /opt 2>/dev/null || df -h /
findmnt /opt 2>/dev/null || true

echo "== network/listen =="
ss -lntp 2>/dev/null | sed -n '1,80p' || true

echo "== tools =="
for bin in git node npm python3 uv nginx jq curl rsync tar lark-cli codex; do
  if command -v "$bin" >/dev/null 2>&1; then
    printf '%-12s %s\n' "$bin" "$(command -v "$bin")"
  else
    printf '%-12s MISSING\n' "$bin"
  fi
done

echo "== red-line reminder =="
echo "Do not modify hostname, /etc/resolv.conf, existing zhuanos hosts entries, sshd config, kernel params, or host firewall unless approved by ops."
