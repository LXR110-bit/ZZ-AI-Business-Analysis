#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <gitclaw-private-repo-url>" >&2
  exit 2
fi

gitclaw_url="$1"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current_origin="$(git remote get-url origin 2>/dev/null || true)"
if [[ -n "$current_origin" && "$current_origin" == *github.com/LXR110-bit/ZZ-AI-Business-Analysis* ]]; then
  if git remote get-url github >/dev/null 2>&1; then
    echo "github remote already exists; keeping origin unchanged" >&2
  else
    git remote rename origin github
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$gitclaw_url"
else
  git remote add origin "$gitclaw_url"
fi

git remote -v
cat <<'MSG'

Next steps:
  git push -u origin main
  git push origin --tags

Do not place tokens in the remote URL. Use a credential helper or Git's interactive password prompt.
MSG
