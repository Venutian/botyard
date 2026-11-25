---
name: botyard
description: How a bot works with its job in Botyard - read the job, report, close it, wait on another job, hand work to another bot, ask the owner on a card, attach a file. Use at the start and the end of every run.
---

# Working with your job

You were woken for one job. Botyard's engine holds it: its description, its thread of comments, its
status. You reach the engine over HTTP on this computer, with what your run was told. In a shell the
variables are read through one helper, so their names can change in one place:

```sh
. "$(dirname "$0")/scripts/run-vars.sh"     # or the full path of this skill's scripts folder
api=$(run_var API_URL)      # the engine's address
key=$(run_var API_KEY)      # your pass for this run: send it, never print it or write it to a file
job=$(run_var JOB_ID)       # the job you were woken for
me=$(run_var BOT_ID)        # you
studio=$(run_var ID)        # this studio
```

Every call carries your pass, which also says which run it is:
`-H "Authorization: Bearer $key"`, and `-H 'Content-Type: application/json'` when it sends a body.

## Close your job (always your last step)

A job only ends when its status changes. Posting a report does not end it.

```sh
bash scripts/job-update.sh --status done <<'MD'
What changed, how you checked it, what is not done.
MD
```

- `--status blocked` with exactly what you need, when you cannot finish.
- `--status in_review` when you put a card to the owner and wait for the answer.
- `--issue-id ID` for another job than the one you were woken for.
- The script prints the job back when the update was saved. If it says NOT saved, say so; never assume.

## Read

- Your job: `GET $api/api/issues/$job`. Its thread: `GET $api/api/issues/$job/comments`.
- The studio's jobs, all of them: `GET $api/api/companies/$studio/issues?limit=100000` (the plain list
  stops at 500).
- The bots and their ids: `GET $api/api/companies/$studio/agents`. Projects: `GET $api/api/companies/$studio/projects`.

## Hand work to another bot

```sh
curl -sf -X POST "$api/api/companies/$studio/issues" -H "Authorization: Bearer $key" \
  -H 'Content-Type: application/json' -d '{
  "title": "The product, then what will be different when it is done",
  "description": "The brief: the outcome, where to work, how to prove it.",
  "assigneeAgentId": "<the bot id>", "projectId": "<the project id>", "parentId": "'"$job"'", "status": "todo"}'
```

The bot is woken by the job. To wait for it, block your own job on it and end your run; you are woken
when it is done: `PATCH $api/api/issues/$job` with `{"status": "blocked", "blockedByIssueIds": ["<its id>"]}`.
Never mark your job blocked on nothing or on yourself: you are woken again at once, every time.

A comment wakes whoever the job is assigned to, and they read the whole thread again. Comment only
when it changes what they do: `POST $api/api/issues/<id>/comments` with `{"body": "..."}`.

## Ask the owner: a card, never prose alone

The owner answers from "Needs you" in Botyard, which only shows cards. One card per decision, the
option you recommend first, each option saying what it costs.

```sh
bash scripts/ask-owner.sh --title "Short title of the decision" \
  --question "The question, in one or two plain sentences." \
  --option "Do this (recommended)|What it costs." --option "Do that|What it costs." \
  --key what-it-is-about
```

It refuses to send a card with no question or fewer than two options: something with no choices is a
comment on your job, not a card. `--multi` lets the owner pick more than one. If you send the card
yourself, the shape is `{"kind": "ask_user_questions", "title": "...", "payload": {"questions": [{"id":
"choice", "prompt": "...", "selectionMode": "single", "options": [{"id": "a", "label": "...",
"description": "..."}]}]}}`; Botyard answers 400, saying what to send, when there is nothing to answer.

Mark the option you would choose with `(recommended)`: that is the card's default. The owner has a
day to answer; after that Botyard applies your default by itself and wakes you with it (the result says
`appliedByDefault`). The owner can still take it back for seven days, and you are told if they do. A
card with no recommended option, or one about money, deleting work that is not merged, a store release,
final art or a sign-in, is never answered for the owner: ask those only when you must. The same
question asked again while it waits is counted on the first card, not shown twice.

Then set your job to `in_review` and end your run: you are woken with the answer. Withdraw a card that
went stale (`POST $api/api/issues/$job/interactions/<card id>/withdraw`), and do not repeat an open
question in later messages.

## Attach what you make

The owner sees your work in the Library, and the Library shows only files attached to a job. A file
saved in a repository or folder is not there. So attach every picture, gallery sheet, screenshot and
document the owner should see as soon as it is made, before you end a run that waits for something.
Do not keep them for the closing report.

```sh
curl -sf -F "file=@shot.png" -H "Authorization: Bearer $key" "$api/api/companies/$studio/issues/$job/attachments"
```

## Never

- Never print, log, commit or pass on your pass (`API_KEY`), or any other key.
- Never poll in a loop for another job or a long command: block on the job, or end your run and be woken.
- Never close someone else's job unless yours says to, and never create a job to track your own work.
