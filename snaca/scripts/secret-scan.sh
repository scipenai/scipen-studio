#!/usr/bin/env bash
set -euo pipefail

pattern='(sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,}|LARK_APP_SECRET[[:space:]]*=[[:space:]]*"[^$".][^"]{8,}|api_key[[:space:]]*=[[:space:]]*"sk-|BEGIN (RSA|OPENSSH|EC|PRIVATE))'

tracked_hits="$(
  git ls-files \
    | while IFS= read -r path; do [[ -f "$path" ]] && printf '%s\n' "$path"; done \
    | xargs -r rg -n -i -I "$pattern" \
    | rg -v 'sk-\.\.\.|tvly-xxxxxxxxxxxxxxxxxxxxxxxx|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|sk-1234567890abcdefghijklmnop' \
    || true
)"

if [[ -n "$tracked_hits" ]]; then
  printf '%s\n' "Potential secret in tracked files:" >&2
  printf '%s\n' "$tracked_hits" >&2
  exit 1
fi

history_hits="$(
  git rev-list --all \
    | xargs -r -n 50 git grep -n -I -i -E "$pattern" \
    | rg -v 'sk-\.\.\.|tvly-xxxxxxxxxxxxxxxxxxxxxxxx|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|sk-1234567890abcdefghijklmnop' \
    || true
)"

if [[ -n "$history_hits" ]]; then
  printf '%s\n' "Potential secret in git history:" >&2
  printf '%s\n' "$history_hits" >&2
  exit 1
fi

printf '%s\n' "No tracked-file or git-history secret pattern hits found."
