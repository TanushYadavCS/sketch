#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
required="$(tr -d 'v[:space:]' < "$repo_root/.node-version")"

matches_required() {
  local current="$1"
  [[ "$current" == "$required" || "$current" == "$required".* ]]
}

current="$(node -p 'process.versions.node' 2>/dev/null || true)"

if ! matches_required "$current"; then
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)"
    fnm use "$required" >/dev/null
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
    nvm use "$required" >/dev/null
  else
    printf "Sketch requires Node %s from .node-version, but current Node is %s and neither fnm nor nvm is available.\n" "$required" "${current:-missing}" >&2
    exit 1
  fi
fi

current="$(node -p 'process.versions.node' 2>/dev/null || true)"

if ! matches_required "$current"; then
  printf "Sketch requires Node %s from .node-version, but current Node is %s.\n" "$required" "${current:-missing}" >&2
  exit 1
fi

exec "$@"
