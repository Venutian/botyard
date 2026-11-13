# Decisions

What is settled in Botyard, each with its reason. A change that goes against one of these is
welcome when it argues with the reason; working around a decision quietly is not.

## One home folder

Everything a yard owns is in `$BOTYARD_HOME` (`~/.botyard` unless chosen): the store, run logs,
the crew's own files, pasted keys, paired phones, the page's saved document. A folder's name comes
from `server/lib/home.mjs` (`crew/studio_home.py` for the helpers) and nowhere else.

Why: a yard can be moved by copying one folder and removed by deleting it, a test gets an empty
yard by naming a temp folder, and the code never has to be searched for a path.

## Botyard writes nothing into another tool's files

It starts the AI tools and reads what they print. Of a tool's own records it reads only what the
phone's list of live sessions needs: when a record was last written, the folder it works in, and
the first thing it was asked (`server/lib/sessions.mjs`).

Why: those records are somebody's work and their tool's to keep. A program that edits them is one
update of that tool away from damaging them.

## The engine answers this computer only

The engine listens on loopback. Under `/api` on the people port it answers a call that came over
loopback, was not handed on by a tunnel or proxy, and names this computer in `Host` and `Origin`.
The phone has a door of its own (`server/phone.mjs`) with every action written out and every
answer cut down to what the app shows; nothing is passed through to the engine as it came.

Why: the engine can start work and change a bot. Nothing on it was made to face another device,
and a written-out list is the only kind of entrance whose size is known.

## The page's API answers the page

`/api/studio...`, `/api/state` and `/api/health` answer a request whose `Host` names this computer,
and for anything that changes something, whose `Origin` does too (`server/lib/page-guard.mjs`).

Why: a website you happen to visit can make your browser send requests to your own computer. The
two headers are what tell the page Botyard served from every other page.

## No secret is read, shown or stored; sign-ins are the tool's own

Setup asks each tool for its own sign-in state and opens the tool's own sign-in in a terminal
(`server/lib/open-terminal.mjs`). A key a person pastes goes to a file only they can read and is
never sent back. A bot's secret variable is kept outside its record and shown as hidden.

Why: Botyard has no account and no server. It should never be the place a password was last seen.

## A run has a keeper of its own

Each run of a bot is started by a small process that outlives the service. Restarting or updating
Botyard does not stop a bot in the middle of its work; the engine books the run when it is back.

Why: a service that cannot be restarted without losing an hour of somebody's tokens does not get
restarted, and then it does not get fixed.

## A job works in a folder and branch of its own, and bots do not push

Every job gets `<project>/.botyard/worktrees/<job>` on its own branch. The default crew may not
push, merge or publish: finished work waits as commits, and merging is a helper's or the owner's.

Why: a bot must never be able to break the checkout a person is working in, and nothing a bot
made should leave the computer without a person, or a rule a person wrote, saying so.

## No page and no script knows a bot by name

A bot is told apart by its role (`lead`, `builder`, `checker`, `reviewer`, `ruler`, `researcher`),
its tier, and the look in its settings. Names, titles and instructions are the owner's to change.

Why: the crew that ships is a starting point. Code that knows "the lead" by a name breaks the day
an owner renames it.

## What is one yard's own stays out of the tree

A yard's own bots (`crew/bots/` in its home), helpers (`crew/own/`) and pages (`pages/`) are read
from the home folder and win over what the tree ships. The tree holds no name, path, address or
key of a real set-up, and `tools/release-check.mjs` fails if one appears.

Why: the same code runs a stranger's yard and its authors' own. The only way both stay true is
that neither needs to edit the tree to be itself.

## Helpers use no AI, and the service runs them

The helper scripts that keep a crew moving are plain programs. The service runs each on its time
(`server/lib/timetable.mjs`): never two of one at once, with a time limit, with its output kept
short, and with a failure shown on the map.

Why: a rule that must hold every minute should cost nothing and behave the same every time.

## The map stands still

The map draws when something changes and otherwise does nothing. There is no idle motion.

Why: it is open all day beside other work. It should read at a glance and take no power to do so.

## The page keeps one document, and it is the page's

`/api/state` keeps whatever object the page saves, stamped with a version (`server/lib/saved.mjs`).
A save says which version it started from; a save from an older one is not written and gets back
what is on disk.

Why: two windows are often open. The server cannot know which of two arrangements a person meant,
so it refuses to choose and lets the page that is behind catch up.

## Few dependencies, and none copied in

The service runs on Node's own modules and three.js. Fonts come from npm at build time. No file
from another project is copied into the tree.

Why: every copied file is somebody else's to licence and ours to keep current. A dependency says
whose it is and can be updated; a copy cannot.
