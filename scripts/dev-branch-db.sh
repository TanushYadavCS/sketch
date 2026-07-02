#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

branch="$(git -C "$repo_root" branch --show-current)"
if [[ -z "$branch" ]]; then
  branch="detached-$(git -C "$repo_root" rev-parse --short HEAD)"
fi

safe_branch="$(printf '%s' "$branch" | tr '/[:space:]' '___' | tr -cd '[:alnum:]_.-')"
export SQLITE_PATH="$repo_root/data/branch-dbs/${safe_branch}.db"
main_db="$repo_root/data/sketch.db"

mkdir -p "$(dirname "$SQLITE_PATH")"

if [[ ! -e "$SQLITE_PATH" && -e "$main_db" ]]; then
  cp "$main_db" "$SQLITE_PATH"
  printf 'Seeded branch database from: %s\n' "$main_db"
fi

printf 'Using branch database: %s\n' "$SQLITE_PATH"

cd "$repo_root"
exec bash "$script_dir/with-node-version.sh" pnpm dev
