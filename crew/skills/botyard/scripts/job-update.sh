#!/usr/bin/env bash
# Closes a job, moves it, or comments on it: the last step of every run.
#
#   job-update.sh [--issue-id ID] [--status STATUS] [--comment TEXT] [--dry-run]
#
# The comment is read from stdin when it is piped in, so a report keeps its lines:
#
#   job-update.sh --status done <<'MD'
#   What changed, and how it was checked.
#   MD
#
# STATUS is one of todo, in_progress, in_review, blocked, done, cancelled. Without --issue-id it is
# the job this run was woken for. It says plainly when the update did not land: a job is only closed
# when this prints the job back. A done report whose COMMIT line names no real commit, or not its
# branch's tip, is refused before anything is sent (commit-line.py says why).
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
. "$here/run-vars.sh"

issue_id=$(run_var JOB_ID)
status=""
comment_arg=""
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue-id) issue_id="${2:-}"; shift 2;;
    --status) status="${2:-}"; shift 2;;
    --comment) comment_arg="${2:-}"; shift 2;;
    --dry-run) dry_run=1; shift;;
    --help|-h) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) printf 'Unknown argument: %s (try --help)\n' "$1" >&2; exit 1;;
  esac
done
if [[ -z "$issue_id" ]]; then
  printf 'No job named: pass --issue-id, or run this inside a job (%s is not set).\n' "$(run_var_name JOB_ID)" >&2
  exit 1
fi
comment="$comment_arg"
if [[ -z "$comment" && ! -t 0 ]]; then
  comment="$(cat)"
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'python3 is needed to send the update and is not installed.\n' >&2
  exit 1
fi
# A done report's COMMIT line must name a real commit, the tip of its branch: the review lands nothing else.
if [[ "$status" == "done" && -n "$comment" ]]; then
  printf '%s' "$comment" | python3 "$here/commit-line.py" || exit 1
fi
payload=$(STATUS="$status" COMMENT="$comment" python3 -c '
import json, os
out = {}
if os.environ["STATUS"]: out["status"] = os.environ["STATUS"]
if os.environ["COMMENT"]: out["comment"] = os.environ["COMMENT"]
print(json.dumps(out))')
if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi
api=$(run_var API_URL); key=$(run_var API_KEY)
if [[ -z "$api" || -z "$key" ]]; then
  printf 'This is not a run of a job: %s or %s is not set.\n' "$(run_var_name API_URL)" "$(run_var_name API_KEY)" >&2
  exit 1
fi
# The engine answers a saved update with the job itself. Anything else means it was not saved. Two
# tries, never a third: a write that fails twice is reported, not repeated.
for attempt in 1 2; do
  set +e
  response=$(curl -sS -m 30 -X PATCH "${api%/}/api/issues/$issue_id" \
    -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    --data-binary "$payload" -w '\n%{http_code}')
  curl_exit=$?
  set -e
  code=""; body=""
  if [[ "$curl_exit" -eq 0 ]]; then
    code="${response##*$'\n'}"
    body="${response%$'\n'*}"
  fi
  if [[ "$curl_exit" -eq 0 && "$code" == 2* ]]; then
    got=$(BODY="$body" python3 -c '
import json, os
try: print(json.loads(os.environ["BODY"]).get("status") or "")
except Exception: print("")')
    if [[ -z "$body" || ( -n "$status" && "$got" != "$status" ) ]]; then
      printf 'The update was NOT saved: the engine answered %s but did not give the job back with status %s.\n' "$code" "${status:-unchanged}" >&2
      [[ -n "$body" ]] && printf '%s\n' "$body" >&2
      exit 1
    fi
    printf '%s\n' "$body"
    exit 0
  fi
  if [[ "$curl_exit" -eq 0 && "$code" == 4* && "$code" != 429 ]]; then
    printf 'The update was refused (%s) and was NOT saved.\n' "$code" >&2
    [[ -n "$body" ]] && printf '%s\n' "$body" >&2
    exit 1
  fi
  if [[ "$attempt" -eq 2 ]]; then
    printf 'The update was NOT saved after two tries (curl %s, answer %s). Say so in your report; do not assume it landed.\n' "$curl_exit" "${code:-none}" >&2
    exit 1
  fi
  printf 'The update did not go through (curl %s, answer %s); trying once more.\n' "$curl_exit" "${code:-none}" >&2
  sleep 2
done
