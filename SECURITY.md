# Security

## Reporting a problem

Please do not open a public issue for something that could put a person's computer or work at risk.
Report it privately through GitHub: on <https://github.com/Venutian/botyard>, open the **Security**
tab and choose **Report a vulnerability**. Say what you found, how to reproduce it, and what it
lets someone do. You will get an answer there, and credit in the fix if you want it.

## What Botyard is, for someone weighing the risk

Botyard runs on your own computer, as you. It starts AI tools that read and change code in your
projects. It has no account and no server of its own, and sends nothing anywhere itself; each AI
tool talks to its own provider with your own sign-in.

## What the service exposes

| | Listens on | Who can reach it | What guards it |
|---|---|---|---|
| The map and its API | `127.0.0.1:5274` | This computer | Answers only its own page: `Host` and `Origin` must be this computer's |
| The engine | `127.0.0.1:3210`, and under `/api` on the map's port | This computer only | See below |
| The phone's door | port 5288, on the address in the door's settings | Paired phones | A key per phone; closed until a first phone is paired |
| Playable builds | port 5290 | A browser holding a build's link | The link's key; a build may load only its own files |

**The engine answers this computer only.** On its own port it refuses any socket that is not
loopback. Under `/api` on the map's port a call must come over loopback, carry no header that a
tunnel or proxy adds, and name this computer in `Host` and in `Origin`; anyone else is told nothing
is there. That last part is what stops a web page you happen to visit from reaching it through
your browser. Nothing passes a call on to the engine raw: the phone's door has a written-out list
of what a phone may ask, and reduces every answer to the fields the app shows.

A bot's run is given a pass that works only while that run is going, and only lets it act as that
bot. Only the owner changes a bot's settings or instructions.

## What a bot can do

A bot's tool runs as you, in a folder and branch of its own inside the project it was given. The
starter crew is kept from pushing, merging, deleting and publishing, so finished work waits for you
as commits; what else a bot may not do is a setting on the bot. These limits are the AI tool's own
permission settings plus Botyard's checks. They are a seat belt, not a sandbox: give a bot only
projects you would give a new colleague, and read what it commits.

Free models are run by providers you did not choose one by one. Do not give a free-model bot a
project with secrets in it.

## Secrets

- Botyard never types or stores a password. It opens each tool's own sign-in.
- A key you paste on the setup page goes to `$BOTYARD_HOME/keys/<name>.key`, readable by you alone,
  and is never sent back to a page.
- A secret variable you give a bot is kept in a file of its own, readable by you alone; every read
  through the API shows it as hidden.
- The phone's door keeps only a hash of each phone's key.
- Run logs hold what a tool printed. If a tool prints a secret, it is in that run's log in your
  home folder; logs never leave your computer.

## Away from home

WireGuard (`tools/away.mjs`) is the private way: only your phone and your computer can read the
traffic. The Cloudflare way (`edge/`) ends HTTPS at Cloudflare, which can therefore read what
passes; the Worker lets through only requests carrying a gate secret that the door hands to phones
already paired, and the door still checks the phone's key.

## Supported versions

Fixes go into the newest release. There are no long-lived older branches.
