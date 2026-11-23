# Getting started

From nothing to a bot answering you, in about ten minutes. There are two ways to get Botyard; both
end on the same first-run guide in the map.

## 1. Get Botyard

**The desktop app** is the easy way. Download the file for your system from the
[latest release](https://github.com/Venutian/botyard/releases/latest):

| System | File | Install |
|---|---|---|
| Windows | `Botyard-<version>-win-x64.exe` | Run it. Windows says it protected your PC: press **More info**, then **Run anyway**. |
| macOS, Apple Silicon | `Botyard-<version>-mac-arm64.dmg` | Open it and drag Botyard to Applications. The first time, see [Opening an unsigned app](#opening-an-unsigned-app). |
| macOS, Intel | `Botyard-<version>-mac-x64.dmg` | The same. |
| Linux | `Botyard-<version>-linux-x86_64.AppImage` | `chmod +x` it, then run it. |
| Debian, Ubuntu | `Botyard-<version>-linux-amd64.deb` | `sudo apt install ./Botyard-<version>-linux-amd64.deb` |

The app carries Botyard and the Node.js it runs on. When you open it, it starts Botyard and shows
the map; when you close it, Botyard stops (a bot in the middle of a run finishes its run).

**From the source**, if you want to change Botyard or keep it running without a window. You need
[Node.js](https://nodejs.org) 22.13 or newer (24 recommended) and [Git](https://git-scm.com/downloads):

```bash
git clone https://github.com/Venutian/botyard.git
cd botyard/studio
npm install
npm start
```

Then open **http://127.0.0.1:5274**. The first start builds the map, which takes about a minute.
To keep it running after you close the terminal, see "Start in five minutes" in the
[README](../README.md#start-in-five-minutes).

## 2. Install one AI tool

Bots run on AI tools you install yourself. Botyard never sees a password: each tool signs in on its own.
Start with **OpenCode**: it runs free models with no account and no card, so your first job costs nothing.

**The easy way: from Botyard itself.** Open **Setup** (or step 2 of the first-run guide) and press
**Install OpenCode**. A terminal opens and installs it; press **Check again** when it is done.

| Your computer | What the Install button does | What you need first |
|---|---|---|
| macOS | Runs OpenCode's own installer (`curl -fsSL https://opencode.ai/install \| bash`) | Nothing |
| Linux | The same, or `npm install -g opencode-ai` when you have Node.js | Nothing |
| Windows | `npm install -g opencode-ai` | [Node.js](https://nodejs.org) (take the LTS installer), or in PowerShell: `winget install OpenJS.NodeJS.LTS`. Close and open Botyard again after installing it. |

**By hand**, if you prefer a terminal:

| Tool | Costs | Install | Sign in |
|---|---|---|---|
| OpenCode | Nothing: free models, no account | `npm install -g opencode-ai` (or, on macOS and Linux, `curl -fsSL https://opencode.ai/install \| bash`) | Nothing to do |
| Claude Code | Your Claude plan | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex | Your ChatGPT plan | `npm install -g @openai/codex` | `codex login` |
| Gemini | Your Google account | `npm install -g @google/gemini-cli` | run `gemini` once |

Claude, Codex and Gemini install with `npm`, which comes with Node.js. Setup shows each one, says
whether it is installed and signed in, and opens the install or the sign-in in a terminal for you.

### More free models: free keys (optional)

OpenCode's free models have a daily allowance. When it is used up, a bot says so in the chat
("No free model answers now") and the free models come back the next day. To have more free models
at once, add free keys on **Setup**. Nothing to install: press **Get a free key** beside a provider,
make the key on its site, then press **Paste a key** and paste it.

| Provider | What is free | Card needed |
|---|---|---|
| OpenRouter | Models whose name ends in `:free`, about 50 requests a day | No |
| NVIDIA | Its hosted models, about 40 requests a minute | No |
| Google Gemini | Gemini Flash models on an AI Studio key, a daily cap per model | No |
| Mistral | Every model at a low rate (asks a phone number) | No |
| SambaNova | Its hosted models at a low daily cap | No |
| Cohere | A trial key, about 1,000 calls a month | No |

A key is kept in a file only you can read on this computer and is never shown again. The free bots
use every provider you add, best model first.

## 3. Follow the first run

An empty yard opens on a guide of seven steps. Each step checks itself, and any of them can be
skipped and done later from **Setup**.

1. **Name your yard.**
2. **Connect an AI.** The list from step 2 above, with the state of each tool on this computer.
3. **Pick a crew.** The default crew is a lead, builders and a checker on free models, and a Claude
   builder that stays off until Claude is signed in.
4. **Say hello to a bot.** The chat opens beside the guide. A first answer takes a minute or two
   while the bot's AI starts. When it comes, everything works.
5. **Add a project.** A folder on this computer that is a Git repository (Botyard offers to start
   Git in one that is not), or a GitHub address to copy.
6. **Give a first job.** Something small, like "Write a README for this project". You watch it
   move from building to checking; the work ends as commits on a branch of its own.
7. **Pair a phone** (optional, Android). Install the phone app from the release, point the phone's
   camera at the code the map shows, and the app connects.

## When something goes wrong

| What you see | What to do |
|---|---|
| "Port 5274 is in use" | Botyard is already running (in a terminal, as a service, or in the app). Open http://127.0.0.1:5274. To run a second one, start it with another port: `PORT=5300 npm start`. In the app, the page says which program holds the port. |
| "No AI tool is ready yet" | Install one of the tools in step 2, then press **Check again** in Setup. |
| A tool you installed is "not installed" in the app | Close the app and open it again: it reads where programs are when it starts. |
| "Botyard still needs: Git" | Install Git, then **Check again**. Every job ends in a commit, so Botyard cannot work without it. |
| "Botyard needs Node.js 22.13 or newer" | Install a newer Node.js from nodejs.org, then start again. |
| A bot says "No free model answers now" | The free allowance is used up for today. Add a free key on **Setup** (see "More free models" above), sign in to Claude, Codex or Gemini, or wait until tomorrow. |
| A bot does not answer after five minutes | In **Setup**, check its AI says Ready. In **Crew**, check the bot is on, then open its last run: the log says what its AI said, and a sign-in or limit error shows there. |
| A job is not taken | The lead takes new jobs. Check the lead is on and its AI is ready. A job waiting on you is in **Needs you**. |
| The phone cannot connect | The phone must be on the same Wi-Fi as the computer. Allow incoming connections on port 5288 in the computer's firewall (Windows asks the first time). Away from home, see "Away from home" in the README. |
| The helpers do not run | They need Python 3 (`python3`, or `python` on Windows). The map and the bots work without it. |
| The app says Botyard did not start | Press **Log** in its top bar for what Botyard wrote. |

Where things are: the yard itself is in `~/.botyard` (on Windows `C:\Users\<you>\.botyard`). The
desktop app writes Botyard's log to `~/.config/Botyard/logs/botyard` on Linux,
`~/Library/Logs/Botyard/botyard` on macOS and `%APPDATA%\Botyard\logs\botyard` on Windows.

## Opening an unsigned app

The installers are not signed with a paid developer certificate, so each system warns once:

- **Windows:** in the blue "Windows protected your PC" box, press **More info**, then **Run anyway**.
- **macOS:** open Botyard once (it is refused), then open **System Settings → Privacy & Security**
  and press **Open Anyway** next to Botyard. Or, in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Botyard.app`
- **Linux:** an AppImage needs to be marked as a program: `chmod +x Botyard-*.AppImage`.
- **Android:** allow your browser or file manager to install unknown apps when the phone asks.
