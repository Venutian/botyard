# The crew

Botyard runs a crew of bots on your computer. You talk to the **Lead** in the app, on the phone or the
PC, and say the outcome you want. The Lead turns it into jobs, gives each to the right bot, has every
build checked, and comes back to you with what is ready, or with a card when something is yours to decide.

## The crew you start with

Eight bots, each with a job of its own. Four run on free models and work from the first minute; four
run on Claude and stay off, with the reason shown, until you sign in to Claude on the Setup page.

| Bot | Runs on | What it is for |
|---|---|---|
| Lead | a free model | Talks with you, finds the facts, writes each job as a brief, gives it to the right bot, follows every build through its check. Never builds |
| Builder | a free model | Builds whatever a free model can try, proves it by running it, commits to the job's own branch. Costs nothing |
| Checker | a free model of another family than the build's | Checks every free build: runs the proof itself, fails only what a user would meet, never changes the work |
| Researcher | a free model | Answers a question from the web and the project's files, with sources and how sure it is |
| Claude Builder | Claude Sonnet | Everyday work that is clear from its brief, and free builds that failed their check |
| Senior Builder | Claude Opus | The hard building: design, architecture, faults nobody understands yet |
| Reviewer | Claude Opus | Fresh eyes on a Claude build: the diff against the brief, the proof run again |
| Ruler | Claude Opus | The big calls you would otherwise be asked: which design, whether a bar is met or may move |

No bot can push, merge, publish, send mail or spend money: each of those comes to you as a card first.

## How a piece of work moves: build, check, ruling

1. **You say the outcome** to the Lead. It reads the project, then writes a job whose description is the
   whole brief: OUTCOME, WHERE, THE BAR, PROOF, NOT. Steps that follow each other in the same code are
   one job with PHASES, so the builder keeps what it learned.
2. **Free first.** The job goes to Builder unless it is past a free model from the start; then Senior
   Builder, when Claude is signed in. With only free models, everything goes to Builder and the Lead
   tells you when a job is beyond it.
3. **The builder builds, proves and commits** on the job's own branch, and ends its report with three
   lines a script reads: `OUTCOME:`, `CHANGE:` and `COMMIT:`.
4. **A script sends the build to its check**, with no AI (`crew/pipeline.py`, every minute on the
   timetable as `review-guard`). A free build goes to Checker; a Claude build to Reviewer, or to Checker
   while Reviewer is off. A build that kept nothing in the project gets no check: its report goes to the Lead.
5. **The check ends `VERDICT: PASS` or `VERDICT: FAIL`.** A pass goes to the Lead, who tells you what is
   ready and asks on a card whether to merge. A fail goes back to the same builder once, from its own
   commit, with the blocking items; a second fail goes to the Lead, who hands it to a stronger builder
   or puts the options to you. Only blocking items are work; notes go into the next brief.
6. **A big call becomes a ruling**: a job titled `Ruling: ...` for the Ruler, answered with `RULING`,
   `WHY`, `COSTS`, `NEXT`. While the Ruler is off, the same decision comes to you as a card.

The same script wakes a job left in progress with no run (three times, an hour apart, then the Lead is
told) and tells the Lead of a job that is blocked on nothing. `botyard-wait` lets a bot start a long
test, end its run, and be woken in the same session when the test is done, so nothing is spent waiting.

## Changing the crew

Everything above is yours to change, in the app's crew editor or in files:

- **A bot's name, title, AI, model, effort, limits, look and instructions** are in its two files (next
  section). Edit them in the app, or copy the file into your home folder and change it there.
- **Who gets what** is the Lead's instructions (`crew/bots/lead.md`, the parts WHO GETS A JOB and WHAT
  HAPPENS TO A BUILD). The scripts go by each bot's `role`, never by its name: a second builder, a
  checker on another AI, or no ruler at all need no change to a script.
- **The rules several bots share** (how a build is reported, phases, long commands, how a check is
  written, what always goes to you) are the paragraphs in `crew/bots/shared/`. The three closing lines
  and the verdict line are what the script reads: reword around them, keep the lines.
- **The pipeline itself**: put your own job named `review-guard` into your `crew/own/timetable.json`
  and it runs in place of ours.

## Free models

The free bots run in OpenCode. Its own free models need no key at all, and still give the Builder and
the Checker different model families, so one model's blind spots do not pass its own mistakes. A key for
OpenRouter or NVIDIA, pasted on the setup page or signed in to with `opencode auth login`, adds their
free models to the list (`FREE` in `crew/setup-bots.py`, best first).

Each free model has its own unpublished limit, and over a limit it simply stops answering. A bot's run
goes through `crew/free-runner.py`: when the run goes quiet it asks the model for one word, sets a model
that does not answer aside, and carries on with the next one in the same session, with nothing lost.
`fallback.py` (every two minutes, on Botyard's timetable) keeps the free bots on a model that answers
and wakes a job left with no run; `free-scout.py` (daily) tests new free models with a hidden coding
test and adds the ones that pass; `free-limits.py` shows what each model usually gives before it stops.
What a free model is sent may be used to train it, so put nothing secret in a job for a free bot.

## The crew is files

Every bot is two files, and Botyard's crew editor and `crew/setup-bots.py` both work from them:

- `crew/bots/<name>.json`: its settings in plain words: name, `role` (`lead`, `builder`, `checker`,
  `reviewer`, `ruler`, `researcher`, `general`), `tier` (`light` or `strong`), who it answers to, which AI
  runs it (`claude`, `codex`, `gemini` or `free`), model, effort, time limit, turns, what it may not do,
  skills, on or off, and its `look` on the map (colour, hat, build, gear, face). No key and no value of a
  variable is ever in it.
- `crew/bots/<name>.md`: its instructions as text. A line like `{{shared: footer}}` pulls in a paragraph
  several bots share, from `crew/bots/shared/`; `{{crew~}}`, `{{own~}}`, `{{projects}}` and the like stand
  for this computer's folders.

No script and no page knows a bot by its name: they go by role, so you can rename every bot.

## Your own crew, helpers and looks

What is yours lives in your home folder, `$BOTYARD_HOME` (default `~/.botyard`), never in the repository:

- `crew/bots/`: your own bots. A `<name>.md` there replaces ours, a `<name>.json` there is laid over ours
  and holds only what differs, and a bot that is only there is yours. If your `crew/bots/crew.json` lists
  `bots`, your crew is exactly those.
- `crew/own/`: your own helper scripts, and `crew/own/timetable.json` to have Botyard run them (same
  shape as `crew/timetable.json`; `{own}` in a command is that folder). Also read from there when present:
  `skills/` (your own skills, given to the bots at each seed), `claude-bot.sh` (run at the start of every
  Claude bot), `guard.json` (folders no bot may touch) and `skills-left-out.json` (why a skill is given to nobody).
- `config/faces/`: your own faces for the bots, named in a bot's `look.face`.
- `pages/`: pages of your own on the map, one folder each, for what only your studio needs
  ([how](studio/docs/how-botyard-works.md#a-page-of-your-own)). It is code you trust: it runs inside Botyard.

`python3 crew/setup-bots.py` seeds the crew into the engine; `--dry` says what would change and writes
nothing; `--only <name>` seeds one bot; `--list` prints the crew. A seed never writes over what you
changed in Botyard: it remembers what it last wrote for each bot, and anything that differs from that
(a title, a model, a time limit, the instructions) is yours. It is kept, and written into your own file
so it stays.

## Where things are

`crew/botyard_home.py` (and `botyard-home.sh` for shell scripts) are the one place a folder, a tool's
path or a run variable's name comes from. Everything is under `$BOTYARD_HOME`: `crew/` (bots,
instructions, the crew's state), `keys/`, `config/`, `run-logs/`. Projects are looked for beside the
repository unless `BOTYARD_PROJECTS` names another folder. `crew/install.sh` works from wherever the
repository was cloned and only links the crew's scripts into `$BOTYARD_HOME/crew`.

A bot's run is told `BOTYARD_API_URL`, `BOTYARD_API_KEY`, `BOTYARD_RUN_ID`, `BOTYARD_JOB_ID`,
`BOTYARD_BOT_ID` and `BOTYARD_ID`. The job skill, `crew/skills/botyard/`, says how a bot reads its job,
hands work on, asks you on a card and closes the job.
