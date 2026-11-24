# Tracks: the way a job moves, kept as data

A **track** is a saved way for work to move through the yard: who starts, what is checked, where a
failed check sends the work back, where the owner is asked, and when the work counts as finished.
Before tracks, that knowledge lived in the crew's scripts and in the lead bot's instructions, so a
missed rule cost a whole job. With a track, the engine runs the rule.

## Words

| Word | Meaning |
|---|---|
| **track** | A saved flow: steps and the lines between them. Versioned, kept in the store, one set per studio. |
| **step** | One piece of a track. Four kinds, below. |
| **line** | An arrow from one step to the next, taken on a pass, a fail, or always. |
| **back-line** | A line to an earlier step, taken when a check fails. It carries the findings and has a round limit. |
| **request** | The job the owner or the lead asked for. Every trip belongs to one request. |
| **trip** | One run of a track for a request. It can be paused, resumed and rerun from a step. |
| **snapshot** | What a step left when it finished (files, a verdict, numbers, its cost), kept for good. |
| **gate** | A step where the trip waits for the owner. |

"Routines" stays the word for work that starts on a timetable. A routine may start a request whose
work then moves along a track.

## Step kinds

- **bot** — a role does the work: the step names a bot (its instructions, model, skills and
  connectors come with it) and the words for this step. The engine makes a job for it under the
  request, wakes the bot, and reads the result when the job closes.
- **script** — a plain command, no AI: tests, a lint, a size check, a merge. Used wherever a script
  will do. Exit code 0 is a pass; the script may also write a small JSON result (verdict, numbers,
  files) to the file named in `BOTYARD_STEP_OUT`.
- **gate** — the owner decides. The trip waits until the owner approves, sends the work back to a
  step with a note, or adds context and reruns a step. The gate also shows as a card in Needs you.
- **track** — runs another saved track as one step and takes its result.

## What a step needs and leaves

Each step says what it **needs** (names such as `brief`, `commit`, `findings`) and what it
**leaves** (`commit`, `verdict`, `report`, `tests`). The engine starts a step when every name it
needs is there, from the request or from an earlier step's snapshot, and keeps what it left as that
step's snapshot. A later step reads the newest value of each name.

## Lines, rounds and endings

- A line goes `from` one step `to` another, `on` pass, fail or always.
- A **back-line** goes to an earlier step on a fail. It hands over the failing step's findings,
  and has `rounds`: how many times it may be taken in one trip. Past its rounds the trip takes its
  `then` step instead, which must be a gate or a ruling step (a bot asked to decide).
- **A track cannot end on a fail with nothing after it.** Every step that can fail has a fail line;
  a track that breaks this is refused when it is saved.
- A trip ends when a step passes and has no line out. A step's fail that finds no line (it cannot,
  by the rule above) would stop the trip as **stuck**, never as done.

## Requests and "finished"

A request says which project and which track. It is **finished only when its change is in the
project's main branch**: when the last step passes, the engine looks for the commit the trip left
(`commit`) in the main branch of the project's repo. Until it is there the request shows
**done, not in main** and the engine looks again on every turn. A track that delivers no change (a
report, a ruling) says `delivers: "nothing"` and finishes with its last step.

Cost is added up per request: every bot step's run cost (all rounds, all reruns) and any cost a
script reports, so the Work sheet can show what a request cost from start to main.

## Pause, resume, rerun

- **Pause** stops new steps from starting; a step already working finishes and its snapshot is kept.
- **Resume** goes on from where it stopped.
- **Rerun from a step** keeps every snapshot before that step and runs it again (and what follows).
  A late failure does not pay for the early steps again. The owner can add context to the rerun.

## Store

Five tables, each row with its whole object kept as JSON next to the columns that are searched:

| Table | One row is | Key columns |
|---|---|---|
| `tracks` | a saved track (its newest version number) | id, company, key, title, status |
| `track_versions` | one saved version: steps, lines, `delivers` | id, track, version |
| `requests` | a job asked for, on a track | id, company, project, job, track, status, cost |
| `trips` | one run of a track version for a request | id, request, track, version, status, parent trip and step |
| `trip_steps` | one try of one step in a trip: its inputs, its snapshot, its job, its cost | id, trip, step, try, status |

## Built in

- **sample-check** — a script counts what is in the folder, then the owner looks. No bot, no key: the
  demo yard runs it on start.
- **build-check-land** — the crew's way. A brief check (the request's words, with the sections the
  studio asks for; a lead bot writes the brief when they are missing), a build, the tests, a check by
  another bot, back to the builder with the findings when a check fails (two rounds), a ruling by the
  lead when the rounds are used, the owner when the ruling says no, and the landing in main. Its bots
  are named by role: `$builder`, `$checker` and `$lead` are inputs, which a studio fills once as the
  track's **defaults** (saved as its own copy) or a request names. A request may give `test_command`.

A bot step's job ends with a line `TRACK STEP: <trip>/<step>/<try>`, so the crew's own scripts can
leave such a job to its track. A bot leaves its results as documents on its job, or as `NAME: value`
lines at the end of its last comment (`COMMIT: …`, `VERDICT: PASS`, `OUTCOME: MET`). A build that names
no commit leaves the head of its own branch when it moved.

Script steps may call the tools in `studio/server/engine/track-tools/` through `$BOTYARD_TRACK_TOOLS`:
`brief.mjs [SECTION …]` and `land.mjs` (merge into main only after the repo's release check and the
test command pass on the merged tree, apart from the project's folder; nothing is pushed). A script
step is told the request's values as `BOTYARD_IN_<NAME>`, and `BOTYARD_PROJECT_FOLDER`, `BOTYARD_MAIN`,
`BOTYARD_REQUEST_TITLE`, and writes its result as JSON to `BOTYARD_STEP_OUT`.

## How today's crew maps onto a track

| Today | On a track |
|---|---|
| The lead writes a brief and starts a builder | a bot step `brief` (the lead) that leaves `brief`, then a bot step `build` |
| Tests, lint, size checks run by scripts | script steps that need `commit` and leave a verdict |
| A second bot checks the build | a bot step `check` (another bot) that leaves a verdict |
| A failed check gets a fix job | the back-line from `check` to `build`, with the findings, up to its rounds |
| Past the rounds, the lead or a judge decides | the back-line's `then`: a ruling step or a gate |
| A passed job is merged by a script | a script step `land` that leaves the `commit` in main |
| "Done, not in main" found later by a sweep | the engine refuses to call the request finished until the commit is in main |
| An owner card for the always-ask list | a gate step |

## Left out on purpose

- **Editing a track on the page.** The first view draws the track and is read-only; tracks are
  saved through the API and from files. Editing on the page comes later.
- **Steps in parallel inside one trip.** Steps run one after another; two requests run side by side.
- **Conditions written as code on lines.** A line is taken on pass, fail or always, nothing more.
- **Timers inside a track.** Starting work on a timetable stays with routines.
- **Moving every crew rule at once.** A project moves onto a track when it is ready; the others go on
  as before.

## Limits that keep work from going round

- **Five tries a step.** However many lines send work back to a step, a trip tries it at most five times
  (`maxTries` on a track sets another number). Past that the trip is stuck, and its request's job is blocked
  once with the reason, for a person to decide.
- **One request a goal.** A request for a goal that already has a request moving in the same project is
  refused, and the refusal names the one that carries it. A track is never started on one of its own steps.
- **No job left open.** On every turn, a round that ended has its job closed with why; a stuck request's
  job is blocked once; a stopped one is closed.
