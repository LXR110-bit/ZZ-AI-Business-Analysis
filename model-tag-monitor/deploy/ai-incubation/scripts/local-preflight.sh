#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "== repository =="
printf 'root=%s\n' "$repo_root"
git status --short --branch
git remote -v

echo "== tracked runtime/sensitive-looking paths =="
git ls-files | grep -E '(^|/)data/|(^|/)logs/|node_modules|\.env$|secret|token|key' || true

echo "== working tree diff summary =="
git diff --stat || true

echo "== blocking secret scan =="
# Block real credential shapes. Allow documented placeholders in .env.example and explicit test fixtures.
patterns=(
  'glpat-[A-Za-z0-9_.-]{20,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'BEGIN (RSA|OPENSSH|PRIVATE) KEY'
  '(APP_SECRET|LARK_APP_SECRET|PASSWORD|TOKEN|ACCESS_CODE)=[A-Za-z0-9_.:/+-]{12,}'
)
failed=0
for pattern in "${patterns[@]}"; do
  if git grep -n -I -E "$pattern" -- . \
      ':!*.md' \
      ':!**/.env.example' \
      ':!**/test/**' \
      ':!review_gate/tests/**' \
      ':!package-lock.json'; then
    failed=1
  fi
done
if [[ "$failed" == "1" ]]; then
  echo "ERROR: potential real secrets found above. Remove/rotate before pushing to gitclaw." >&2
  exit 1
fi

echo "== hard-coded production access code scan =="
if git grep -n -I '[W]XFX2026' -- . ':!**/test/**'; then
  echo "ERROR: old production access code fallback still exists outside tests." >&2
  exit 1
fi

echo "local preflight passed"
