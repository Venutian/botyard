#!/usr/bin/env bash
# Puts one decision to the owner as a card on this run's job: what Botyard shows under "Needs you".
#
#   ask-owner.sh --title TEXT --question TEXT --option "LABEL|WHAT IT COSTS" --option "LABEL|..." \
#                [--multi] [--key WORDS] [--issue-id ID] [--dry-run]
#
# Give the option you recommend first, with "(recommended)" in its label. Two options at least; each
# says what it costs after a "|". --multi lets the owner pick more than one. --key names the decision
# (letters, numbers, dashes): asking the same decision again with the same key gives back the card
# already open instead of a second one. Then set your job to in_review and end your run: you are woken
# with the answer. Nothing is sent without a question and options, so the owner never gets a card with
# nothing to answer.
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
. "$here/run-vars.sh"

issue_id=$(run_var JOB_ID)
title="" question="" key="" multi=0 dry_run=0
options=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="${2:-}"; shift 2;;
    --question) question="${2:-}"; shift 2;;
    --option) options+=("${2:-}"); shift 2;;
    --multi) multi=1; shift;;
    --key) key="${2:-}"; shift 2;;
    --issue-id) issue_id="${2:-}"; shift 2;;
    --dry-run) dry_run=1; shift;;
    --help|-h) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) printf 'Unknown argument: %s (try --help)\n' "$1" >&2; exit 1;;
  esac
done
if [[ -z "${question// }" ]]; then
  printf 'Not sent: give the question with --question. A card with no question has nothing for the owner to answer.\n' >&2
  exit 1
fi
if [[ ${#options[@]} -lt 2 ]]; then
  printf 'Not sent: give at least two choices with --option "LABEL|what it costs". To ask something with no choices, write a comment on your job instead.\n' >&2
  exit 1
fi
if [[ -z "$issue_id" ]]; then
  printf 'No job named: pass --issue-id, or run this inside a job (%s is not set).\n' "$(run_var_name JOB_ID)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'python3 is needed to send the card and is not installed.\n' >&2
  exit 1
fi
payload=$(TITLE="$title" QUESTION="$question" KEY="$key" MULTI="$multi" JOB="$issue_id" python3 -c '
import json, os, re, sys
options = []
for n, given in enumerate(sys.argv[1:]):
    label, _, cost = given.partition("|")
    if not label.strip():
        sys.exit("Not sent: option %d has no label." % (n + 1))
    options.append({"id": "option-%d" % (n + 1), "label": label.strip(), **({"description": cost.strip()} if cost.strip() else {})})
question = os.environ["QUESTION"].strip()
title = os.environ["TITLE"].strip() or question[:120]
key = re.sub(r"[^a-z0-9-]+", "-", (os.environ["KEY"] or title).lower()).strip("-")[:80]
print(json.dumps({
    "kind": "ask_user_questions", "title": title,
    "idempotencyKey": "question:%s:%s" % (os.environ["JOB"], key),
    "resolverPolicy": "human_only", "continuationPolicy": "wake_assignee",
    "payload": {"version": 1, "questions": [{
        "id": "choice", "prompt": question, "selectionMode": "multi" if os.environ["MULTI"] == "1" else "single",
        "required": True, "options": options}]}}))' "${options[@]}")
if [[ "$dry_run" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi
api=$(run_var API_URL); key_pass=$(run_var API_KEY)
if [[ -z "$api" || -z "$key_pass" ]]; then
  printf 'This is not a run of a job: %s or %s is not set.\n' "$(run_var_name API_URL)" "$(run_var_name API_KEY)" >&2
  exit 1
fi
out=$(mktemp); trap 'rm -f "$out"' EXIT
code=$(curl -s -o "$out" -w '%{http_code}' -X POST "${api%/}/api/issues/$issue_id/interactions" \
  -H "Authorization: Bearer $key_pass" -H 'Content-Type: application/json' --data-binary "$payload" || true)
if [[ "$code" != 2* ]]; then
  printf 'The card was not saved (%s): %s\n' "${code:-no answer}" "$(head -c 600 "$out")" >&2
  exit 1
fi
cat "$out"; printf '\n'
