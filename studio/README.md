# Botyard: the service

This folder is the program that runs on your computer: the map (`src/`, built into `dist/`), its
server and the engine (`server/`), and the tools around them (`tools/`).

What Botyard is and how to start it is on the [front page](../README.md). In short:

```bash
npm install
npm run demo       # look first: Botyard on a made-up studio, on http://127.0.0.1:5275
npm start          # the whole of Botyard on your own yard, on http://127.0.0.1:5274
```

`node tools/sample-yard.mjs <folder>` fills an empty home folder with the same made-up studio and
stops, for when you want to keep one to try things on (`BOTYARD_HOME=<folder> BOTYARD_ENGINE_RUNS=off npm start`).

| Command | |
|---|---|
| `npm start` | Builds the page if it was never built, then runs `server/studio.mjs` |
| `npm run demo` | The same service on a made-up studio (`tools/sample-yard.mjs`) in a throwaway home, on port 5275: the engine answers, no bot is started, no helper runs, the phone's door stays closed. Local agent sessions are not read into it |
| `npm run dev` | The page with live reload and the same API |
| `npm run build` | Builds the page into `dist/` |
| `npm test` | Every test, each in an empty temp home on spare ports |
| `npm run check-clone` | Clone, install, build, start in an empty home, and take one job to a commit with a stand-in for the AI tool |
| `npm run install-service` | Keeps Botyard running: a service on Linux, a launch agent on macOS; on Windows it names the shortcut installer, `tools\install-windows.ps1` (`-- --dry` prints it, `-- --remove` takes it away) |
| `npm run shots` | Retakes the front page's pictures from the demo with a headless browser, into `docs/images/` (see the top of `tools/shots.mjs`) |

Ports, all changeable where Botyard is started:

| Variable | Default | |
|---|---|---|
| `PORT` | 5274 | The map, for you |
| `BOTYARD_PHONE_PORT` | 5288 | The phone's door |
| `BOTYARD_ENGINE_PORT` | 3210 | The engine, for this computer only: the bots and the helper scripts call it |
| `BOTYARD_HOME` | `~/.botyard` | Everything a yard owns |

How the parts fit together: [`docs/how-botyard-works.md`](docs/how-botyard-works.md). Settled
questions and their reasons: [`DECISIONS.md`](DECISIONS.md). Listing another tool's working agents
in the phone app: [`docs/custom-agents.md`](docs/custom-agents.md).

MIT, see [LICENSE](LICENSE).
