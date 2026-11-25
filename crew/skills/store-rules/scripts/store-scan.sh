#!/usr/bin/env bash
# Botyard's store scan, from wherever this skill sits: the repository's own copy, or a bot's copy of the skills
# (which names the repository in a .repo file beside this folder). Arguments go to studio/tools/store-scan.mjs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
repo=""
[ -f "$here/../.repo" ] && repo=$(cat "$here/../.repo")
[ -z "$repo" ] && repo=$(cd "$here/../../../.." && pwd -P)
tool="$repo/studio/tools/store-scan.mjs"
[ -f "$tool" ] || { echo "Botyard's store scan was not found (looked in $repo)." >&2; exit 1; }
exec node "$tool" "$@"
