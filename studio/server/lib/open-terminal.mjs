/**
 * Opens a terminal window on this computer with one command running in it, for a person to finish:
 * a tool's own sign-in, or its install. Setup's "Sign in" button is the one caller.
 *
 * The command is always a program and its words, never a line of shell that somebody typed. It runs
 * in the folder given; when it ends the window stays until Enter is pressed, so what it said can be read.
 *
 *   Linux     the first terminal program found, each given the command the way it takes one
 *   macOS     a small script file opened with Terminal, which is how Terminal takes a command
 *   Windows   a new Command Prompt window that stays open
 *
 * `{ ok: true }` means a window was asked for. `{ ok: false, error }` says in plain words why not;
 * the caller then shows the command for the person to run themselves.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { findCommand } from './timetable.mjs'

/** Terminal programs on Linux, most usual first, and how each is handed a command to run. */
const LINUX = [
  ['gnome-terminal', (run) => ['--', ...run]],
  ['ptyxis', (run) => ['--', ...run]],
  ['kgx', (run) => ['-e', ...run]],
  ['konsole', (run) => ['-e', ...run]],
  ['xfce4-terminal', (run) => ['-x', ...run]],
  ['mate-terminal', (run) => ['-x', ...run]],
  ['kitty', (run) => run],
  ['alacritty', (run) => ['-e', ...run]],
  ['wezterm', (run) => ['start', '--', ...run]],
  ['foot', (run) => run],
  ['xterm', (run) => ['-e', ...run]],
  ['x-terminal-emulator', (run) => ['-e', ...run]],
]
const DONE = 'Finished. Press Enter to close this window.'
/** Go to the folder, run the words that follow, say it is over, and wait for Enter. */
const STAY = `cd "$1" || exit 1; shift; "$@"; printf '\\n%s\\n' '${DONE}'; read -r _`

const quoteSh = (word) => `'${String(word).replaceAll("'", `'\\''`)}'`
const quoteCmd = (word) => (/[\s&()^|<>"]/.test(word) ? `"${String(word).replaceAll('"', '""')}"` : String(word))

/** Start a program and let go of it; resolves once it has started, or with why it could not. */
function launch(spawn, program, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(program, args, { detached: true, stdio: 'ignore', ...options }) } catch (err) { resolve({ ok: false, error: err.message }); return }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('spawn', () => { child.unref?.(); resolve({ ok: true }) })
  })
}

/**
 * @param {string[]} command  the program (a full path) and its words
 * @param {string} cwd        the folder to run it in
 */
export async function openTerminal(command, cwd, { platform = process.platform, env = process.env, which = (name) => findCommand(name, env), spawn = nodeSpawn, tmp = os.tmpdir() } = {}) {
  const words = Array.isArray(command) ? command : []
  if (!words.length || words.some((word) => typeof word !== 'string' || !word) || !path.isAbsolute(words[0])) return { ok: false, error: 'There is no command to run' }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { ok: false, error: 'There is no folder to run it in' }

  if (platform === 'win32') {
    // `start` opens the new window; the first quoted word is its title. /k keeps it open afterwards.
    const line = `start "Botyard" /D ${quoteCmd(cwd)} cmd.exe /k ${words.map(quoteCmd).join(' ')}`
    return launch(spawn, env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true })
  }

  if (platform === 'darwin') {
    // Terminal runs a file it is asked to open. The file is this one command and is the person's own to read.
    const file = path.join(fs.mkdtempSync(path.join(tmp, 'botyard-run-in-terminal-')), 'Botyard.command')
    fs.writeFileSync(file, `#!/bin/sh\ncd ${quoteSh(cwd)} || exit 1\n${words.map(quoteSh).join(' ')}\nprintf '\\n%s\\n' ${quoteSh(DONE)}\nread -r _\n`, { mode: 0o700 })
    return launch(spawn, '/usr/bin/open', ['-a', 'Terminal', file])
  }

  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { ok: false, error: 'This computer has no screen to open a window on' }
  const run = ['/bin/sh', '-c', STAY, 'botyard', cwd, ...words]
  // A terminal the person named comes first, when it is one whose way of taking a command is known.
  const named = [env.BOTYARD_TERMINAL, env.TERMINAL].filter(Boolean).map((name) => path.basename(name))
  const order = [...LINUX.filter(([name]) => named.includes(name)), ...LINUX.filter(([name]) => !named.includes(name))]
  let last = 'No terminal program was found on this computer'
  for (const [name, hand] of order) {
    const program = which(name)
    if (!program) continue
    const out = await launch(spawn, program, hand(run), { cwd })
    if (out.ok) return out
    last = `${name} could not be started: ${out.error}`
  }
  return { ok: false, error: last }
}
