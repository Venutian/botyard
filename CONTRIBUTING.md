# Contributing to Botyard

Thank you for wanting to make Botyard better. This page is the short version of how to do it.

## Getting set up

```bash
git clone https://github.com/Venutian/botyard.git
cd botyard/studio
npm install
npm test               # the service's tests
npm run check-clone    # the proof that a stranger's first five minutes work
cd ../crew && python3 -m unittest discover -s tests    # the helper scripts' tests
```

Nothing here needs an AI tool, a key or an account: the tests use a stand-in for the bot's tool and
an empty home folder in a temp directory. If a test of yours needs a real model, it is not a test.

Read [`studio/docs/how-botyard-works.md`](studio/docs/how-botyard-works.md) first; it is one page.
[`studio/DECISIONS.md`](studio/DECISIONS.md) lists what is settled and why. A change that argues
with one of those is welcome, as long as it argues with the reason.

## Where things go

| You want to change | Look in |
|---|---|
| The map and its pages | `studio/src/`, `studio/server/api.mjs`, `studio/server/lib/` |
| Jobs, runs, the wake queue, how a bot's tool is started | `studio/server/engine/` |
| What the phone may ask | `studio/server/phone.mjs`, and the app in `src/` and `App.tsx` |
| The starter crew and its instructions | `crew/bots/` |
| Helper scripts and when they run | `crew/*.py`, `crew/timetable.json` |
| Support for another AI tool | `studio/server/engine/adapters.mjs` (to run bots on it), `studio/server/lib/sessions.mjs` (to show its sessions on the phone) |

## The rules a change is held to

- **One home folder.** A folder's name comes from `studio/server/lib/home.mjs` (or
  `crew/botyard_home.py`). New code never writes a folder name out by hand, and nothing is written
  outside `$BOTYARD_HOME` and the project a job belongs to.
- **Variables are `BOTYARD_<NAME>`.**
- **The engine answers this computer only.** A new path for the map goes under `/api/studio/`; a
  new thing a phone may ask is written out in `phone.mjs`. Nothing is passed on raw.
- **No secret is read, printed, logged or stored**, beyond a key a person pastes on purpose, which
  goes to a file only they can read. Botyard never types a password.
- **Nothing of one person's set-up goes in the tree**: no names of real bots or products, no paths
  of one computer, no domains, ids or keys. A yard's own bots and helpers live in its home folder.
  Tests and examples use made-up names (project "Lighthouse", jobs `LH-12`, bots "Lead", "Builder",
  "Checker", "Reviewer").
- **Plain words** on every page and in every message a person reads: say what happened and what to
  do next.
- **No new dependency without a strong reason.** The service runs on Node's own modules and three.js.
- **Tests come with the change**, and `npm test` passes. A fix is tested by the thing that was
  broken, not by a stand-in that could not have failed.
- **Own pages reload fully.** A page in `$BOTYARD_HOME/pages/` is loaded from a copy of its folder
  keyed by the newest change in it, so a change to any file (not only `server.mjs`) is live on the
  next request with no restart. Keep it that way: never import a page's files straight from its folder.

Before a pull request: `npm test` in `studio/`, the crew's tests if you touched `crew/`, and
`node tools/release-check.mjs` from the top folder, which fails on anything personal, anything that
looks like a secret, and any large or binary file that should not be tracked.

## Reporting a bug, proposing a change

Open an issue at <https://github.com/Venutian/botyard/issues> with what you did, what you expected
and what happened; the setup page's state and the line from the service's log help. For a security
problem, see [`SECURITY.md`](SECURITY.md) and do not open a public issue.

By contributing you agree that your work is released under the [MIT licence](LICENSE).
