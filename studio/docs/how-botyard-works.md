# How Botyard works

One page for someone who is about to change Botyard, or wants to know what is running on their
computer. Starting it and using it is in the [README](../README.md).

## One process, four parts

`npm start` runs `server/studio.mjs`. That one process holds:

| Part | Code | Listens on | Who may call it |
|---|---|---|---|
| The map: the built page and its API | `server/api.mjs`, `src/`, `dist/` | `PORT` (5274) | The page itself, on this computer |
| The engine: store, jobs, wake queue, routines | `server/engine/` | `BOTYARD_ENGINE_PORT` (3210), and under `/api` on the people port | This computer only: bots, helper scripts, the map's own server |
| The phone's door | `server/phone.mjs` | `BOTYARD_PHONE_PORT` (5288) | A paired phone, with its own key |
| The timetable: helper scripts on their times | `server/lib/timetable.mjs`, `crew/timetable.json` | nothing | The map's timetable page |

Who answers a path under `/api` on the people port:

1. `/api/studio/setup` and `/api/studio/timetable`: `studio.mjs` itself (`lib/setup.mjs`, `lib/timetable.mjs`).
2. `/api/studio`, `/api/studio/...` and the map's two own paths (`health`, `state`): the map's API.
3. Anything else: the engine, and only when the call started on this computer. That means a loopback
   socket, no header a tunnel or proxy adds, and this computer's own name in `Host` and `Origin`.
   Everyone else is told nothing is there. The engine's own port asks the same (`lib/local-call.mjs`),
   and then who is calling: a run's pass, the owner key (the map's server, the phone's door) or the
   scripts key with the script's name (`engine/caller.mjs`). Only the owner answers a card.

The phone's door passes nothing on raw. Each thing a phone may ask is written out in `phone.mjs`.

## A job, from made to done

1. A job is made (on the map, in the phone app, by a routine, or by a bot through the API) and
   given to a bot. The engine puts a wake for that bot in its queue.
2. On its next turn (every five seconds) the engine starts the wake if the bot is on and has room.
   It makes the job its own folder and branch inside the project,
   `<project>/.botyard/worktrees/<job id>-<title>`, so no bot ever works in your own checkout.
3. The bot's AI tool is started in that folder by a small **keeper** process of its own. The keeper
   outlives the engine: restarting Botyard never stops a bot in the middle of its work, and the
   engine books the run when it comes back.
4. The run is told who and where it is through variables:

   | Variable | |
   |---|---|
   | `BOTYARD_API_URL` | The engine's address, without `/api` |
   | `BOTYARD_API_KEY` | The run's own pass. It stops working when the run ends |
   | `BOTYARD_RUN_ID`, `BOTYARD_JOB_ID`, `BOTYARD_BOT_ID`, `BOTYARD_ID` | This run, its job, its bot, the yard |

   With them the bot reads its job, comments, asks the owner a question, and closes the job through
   the engine's API. The skill that teaches a bot this is `crew/skills/botyard/`.
5. When the tool ends, the engine reads what it printed: the session to carry on next time, the
   tokens used, its last words, and whether it failed. That is the run's record.

Four kinds of tool can run a bot: Claude Code, Codex, Gemini (or any tool that speaks the Agent
Client Protocol) and OpenCode for free models. Which one, with which model and limits, is the bot's
own setting.

## Where everything is kept

One folder, `$BOTYARD_HOME`, by default `~/.botyard`. Its name comes from one place per language,
`server/lib/home.mjs` and `crew/botyard_home.py`; nothing else writes a folder name out by hand.

| | |
|---|---|
| `studio.db` | The store (SQLite) |
| `run-logs/` | Every run's output; the helpers' logs in `run-logs/timetable/` |
| `runs/`, `files/` | What runs leave behind; files attached to jobs |
| `crew/` | The yard's own copies of its bots' files, and the helpers' state |
| `keys/` | Keys pasted on the setup page, one file each, readable by the owner alone |
| `config/` | Paired phones, the door's settings (`phone.env`), limits, the away link |
| `projects/` | Projects added by a GitHub address |
| `agents/` | Status files other tools write to be listed in the phone app while they work (see [custom-agents.md](custom-agents.md)) |
| `pages/` | Pages of your own on the map, one folder each (see below). Not there until you make it |
| `launcher/` | The desktop launchers' own lock, pid and logs |

One store has one engine running bots: the service holds `engine.lock` in the home folder, and a
second Botyard started over the same home answers calls but starts no bot.

## The crew

A bot is two files: `<slug>.json` (name, role, who it answers to, which AI, model, limits, what it
may not do, how it looks on the map) and `<slug>.md` (its instructions). The tree ships one set, the
starter crew, in `crew/bots/`. A yard's own bots are the same two files in `$BOTYARD_HOME/crew/bots/`,
and win over the tree's. `crew/setup-bots.py` seeds the crew through the engine's API and never
writes over what was changed in Botyard since the last seed. No script and no page knows a bot by
name: they go by its `role` (`lead`, `builder`, `checker`, `reviewer`, ...). More in
[`CREW.md`](../../CREW.md).

## The timetable

`crew/timetable.json` lists every helper script: a name, what it is for, its command, and either
`every` (with `after` and `first`) or `at`, plus a time `limit`. A `keeper` entry is a small server
that is kept running. For every job the service guarantees:

- never two of itself at once, also across a restart (a pid file beside its log);
- a time limit, after which it is stopped;
- its output in `run-logs/timetable/<name>.log`, kept short;
- a failure shown on the map with the run's last line.

A yard adds helpers of its own without touching the tree: scripts in `$BOTYARD_HOME/crew/own/`,
listed in `$BOTYARD_HOME/crew/own/timetable.json` in the same shape, where `{own}` in a command is
that folder. An own job with the name of one of the tree's replaces it. A mistake in the own file is
said on the timetable page and never stops the helpers that came with Botyard. A helper is told
`BOTYARD_API_URL`, and uses no AI.

## The PC load button

A yard that has a throttle for its computer names the tool in `$BOTYARD_HOME/config/pc-load.json`,
`{ "tool": "/absolute/path" }`. The page's top bar and the phone's Home then show **PC load**: None,
Light, Medium, Heavy or Full, the level in force now, and on Full how many jobs are paused and the
memory they hold. With no tool named the control is not shown. The tool answers `show --json` with
`{ day, night, now, paused: [ ... ], heldMB }` and takes `<level> [--day|--night]`; it is run with
plain arguments, never a shell, and told `BOTYARD_SET_BY` (`owner (page)` or `owner (phone)`) for
its own log.

The level is the owner's alone. The page's route (`/api/studio/throttle`) answers only a caller on
this computer, and refuses a call with a bot's pass or a script's key, or one made by any process
whose family runs for a bot (its run's variables, read from `/proc`). The phone's route
(`/v1/throttle`) needs a paired phone's key. The owner guard keeps bots out of `pc-load.json`.

## A page of your own

The map can show pages that are yours and are not part of Botyard: a table you keep, a view of files
one of your bots writes. A page is a folder in your home folder, `$BOTYARD_HOME/pages/<name>/`, and
never a change to this repository. The folder may be a link to wherever you keep it.

| File | What it is |
|---|---|
| `page.json` | `{ "title": "Notes", "does": "one line under the title", "script": "page.js", "style": "page.css", "server": "server.mjs" }`. `title` and `script` are needed; `"wide": false` gives the narrow column |
| `page.js` | Runs in the map's page: `export function mount(el, tools) { ... }`. `el` is the page's own box on the sheet. `tools.call(path, payload)` asks your server file and gives back its JSON, `tools.url(path)` is the same address for a link that saves a file, `tools.markdown`, `tools.esc` and `tools.toast` are the map's own. Return a function to tidy up when the sheet moves on |
| `page.css` | Linked once. Use the map's colours (`--text`, `--muted`, `--panel`, `--raise`, `--line`, `--edge`, `--green`, `--amber`, `--red`, `--accent`) and faces (`--sign`, `--body`) so it follows day and night, and its classes (`btn`, `seg`, `table.grid`, `none`, `hint`) where they fit. Start every rule with `.own-page[data-own-page="<name>"]` |
| `server.mjs` | Runs inside Botyard: `export default async function handle({ method, path, query, body, home, folder, runHelper })`. Return `{ status, body }` for JSON, or `{ type, text, download }` for a file to save. `runHelper(name)` starts one of the timetable's helpers now |

Each page is one more entry at the end of the map's rail. Its paths are
`/api/studio/own` (the list), `/api/studio/own/<name>/files/...` (the folder's scripts, styles and
pictures) and `/api/studio/own/<name>/api/...` (your server file, `GET` and `POST`). They are the
map's own paths, so they answer the page on this computer and nobody else, and the sample yard
(`--demo`) shows none. A paired phone reaches the list (`/v1/own`) and a page's own calls
(`/v1/own/<name>/api/...`) through its door, never the page's files: a studio that builds its own phone
screen calls its page through `ownCall` in the app's `src/api.ts`.

**A page on the phone.** Put `"phone": true` in `page.json` and have the server file answer
`GET /phone` with a view: `{ "title", "note", "blocks": [...] }`. The phone app runs none of the page's
code; it draws the blocks with its own parts, and the page gets a chip on the phone's home, beside
Engram, and a big tile in the Studio tab (`"icon"` in `page.json` picks one of the app's icons for it). The blocks are `heading`, `text` (markdown), `tiles` (numbers side by side), `chart` (bars up;
a bar with `pick` opens the view again with `param=pick`), `bars` (bars across, with a `mark` for a usual
amount), `rows`, `list`, `choose` (chips that open the view again with `param=id`), `actions` (buttons
that POST to the page's own server, then read the view again) and `fold` (shut until tapped). Each
item's `tone` may be `good`, `bad` or `warn`. The app leaves out anything else, cuts long words and
lists, and lets a button call only a plain path on the page's own server. The whole list, with each
block's fields, is at the top of `src/ownView.ts`; the web preview's Sales page is an example.

**An own page is code you trust.** Its server file runs with everything Botyard itself may do on
this computer, and its script runs inside the map. Botyard loads nothing unless the folder is there,
its name is lower-case letters, digits and dashes, `page.json` is valid, and every file it names is
inside the folder; the server file and `page.json` are never sent to the browser. A folder that is
not a valid page is listed with the reason in `GET /api/studio/own` under `problems`. Put only your
own code there, as you would in a shell profile. Code: `server/lib/own-pages.mjs`,
`src/ui/own-pages.js`, tests in `test/own-pages.test.mjs`.

## Sign-ins

`lib/setup.mjs` asks each tool for its own state (`claude auth status`, `codex login status`,
`gh auth status`, `opencode auth list`) and never reads a secret. Botyard never types or stores a
password: it opens the tool's own sign-in in a terminal, or takes a pasted key into `keys/`.

## Changing Botyard

- `npm run dev`: the page with live reload and the same `/api`.
- `npm test`: every test (`node --test`), in an empty temp home on spare ports.
- `npm run check-clone`: clone, install, build, start in an empty home, and take one job to a commit
  with a stand-in for the AI tool. This is the proof that a stranger's first five minutes work.
- A new path for the map goes under `/api/studio/`. A new folder goes through `home.mjs`. A new
  variable is `BOTYARD_<NAME>`.
- Settled questions and their reasons are in [`DECISIONS.md`](../DECISIONS.md).
