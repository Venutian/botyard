/**
 * How a bot's tool is started on each kind of computer.
 *
 * On Windows a tool installed with npm (opencode, claude, codex, gemini) is a `.cmd` file, which
 * Node cannot start by its bare name: `spawn('opencode')` fails with ENOENT. Here the name is looked
 * up on the PATH with Windows' own endings, and a `.cmd` or `.bat` file is started through cmd.exe
 * with every word quoted. On macOS and Linux the command is left as it is.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The places a tool's own installer puts it that a running app's PATH may not have yet. */
function extraDirs(env, platform) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const home = (platform === 'win32' && env.USERPROFILE) || env.HOME || os.homedir()
  const dirs = [join(home, '.opencode', 'bin')]
  if (platform === 'win32' && env.APPDATA) dirs.push(join(env.APPDATA, 'npm'))
  return dirs
}

const pathOf = (env) => env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''

/** The file a command name stands for, or null when it is not on this computer. */
export function findTool(name, env = process.env, { platform = process.platform, exists = (f) => { try { return fs.statSync(f).isFile() } catch { return false } } } = {}) {
  if (!name) return null
  const sep = platform === 'win32' ? ';' : ':'
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  // On Windows a bare `opencode` beside `opencode.cmd` is npm's script for Unix shells: the endings come first.
  const endings = platform === 'win32'
    ? (/\.[a-z0-9]+$/i.test(name) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean))
    : ['']
  const given = name.includes('/') || name.includes('\\')
  const dirs = given ? [''] : [...pathOf(env).split(sep).filter(Boolean), ...extraDirs(env, platform)]
  for (const dir of dirs) for (const ending of endings) {
    const file = dir ? join(dir, name + ending) : name + ending
    if (exists(file)) return file
  }
  return null
}

/** One word for cmd.exe, inside double quotes. */
const quoted = (word) => `"${String(word).replace(/"/g, '""')}"`

/**
 * The command, words and spawn options that start `command` with `args` here.
 * `found` is false when the tool is not on this computer (the spawn would fail).
 */
export function launchable(command, args = [], env = process.env, { platform = process.platform, exists } = {}) {
  if (platform !== 'win32') return { command, args, options: {}, found: true }
  const file = findTool(command, env, { platform, exists })
  if (!file) return { command, args, options: {}, found: false }
  if (/\.(cmd|bat)$/i.test(file)) {
    // cmd /s /c "<line>": cmd drops the outer quotes and runs the line as it is.
    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${[file, ...args].map(quoted).join(' ')}"`],
      options: { windowsVerbatimArguments: true },
      found: true,
    }
  }
  return { command: file, args, options: {}, found: true }
}

/** The plain words for a tool that could not be started. */
export function notStarted(command, err) {
  if (err?.code === 'ENOENT') {
    const name = path.basename(String(command)).replace(/\.(cmd|bat|exe)$/i, '')
    return `${name} is not installed on this computer, or Botyard cannot find it. Install it on the Setup page, then restart Botyard.`
  }
  return `The run could not start: ${err?.message || err}`
}

/** Stop a process and everything it started. */
export function stopTree(pid, signal = 'SIGTERM', { platform = process.platform, run } = {}) {
  if (!pid) return
  if (platform === 'win32') {
    // Windows has no process groups to signal: taskkill ends the whole tree.
    const go = run || ((cmd, words) => { try { spawn(cmd, words, { stdio: 'ignore', windowsHide: true }).on('error', () => {}) } catch { /* no taskkill */ } })
    go('taskkill', ['/pid', String(pid), '/T', '/F'])
    return
  }
  try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch { /* already gone */ } }
}

/** The variables Windows programs need that a run's trimmed environment would otherwise lose. */
export const WINDOWS_VARS = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']

/** Those variables out of `env`, for a run on Windows; nothing elsewhere. */
export function windowsEnv(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return {}
  const out = {}
  for (const name of WINDOWS_VARS) if (env[name] !== undefined) out[name] = env[name]
  return out
}

export { pathOf }

/**
 * A free bot run straight on OpenCode (no crew launcher, as on Windows) whose model is "auto": the
 * best free model OpenCode lists now. The crew's free-runner.py does this, with more care, where
 * Python runs. The list is read once an hour; null when OpenCode lists none (it then picks itself).
 */
const FREE_ORDER = ['deepseek', 'glm', 'mimo', 'nemotron', 'kimi', 'qwen', 'minimax', 'longcat', 'big-pickle']
let freeList = { at: 0, models: [] }
export async function autoFreeModel(command, env, { now = Date.now(), list } = {}) {
  if (now - freeList.at > 3600_000 || !freeList.models.length) {
    const out = await (list || listModels)(command, env)
    const free = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^opencode\/\S+$/.test(l) && /free|big-pickle/.test(l))
    freeList = { at: now, models: free }
  }
  const rank = (m) => { const at = FREE_ORDER.findIndex((w) => m.includes(w)); return at < 0 ? FREE_ORDER.length : at }
  return [...freeList.models].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] || null
}
export const forgetFreeList = () => { freeList = { at: 0, models: [] } }

function listModels(command, env) {
  return new Promise((resolve) => {
    const start = launchable(command, ['models', 'opencode'], env)
    if (!start.found) return resolve('')
    try {
      const child = spawn(start.command, start.args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...start.options })
      let out = ''
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(out) }, 30_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => { out += c })
      child.on('error', () => { clearTimeout(timer); resolve('') })
      child.on('close', () => { clearTimeout(timer); resolve(out) })
    } catch { resolve('') }
  })
}

/**
 * What OpenCode says when its free allowance is used up. It then retries in silence until the run's
 * time limit, so the keeper stops the run at once and says why (as free-runner.py does).
 */
export const FREE_REFUSED = ['free usage limit', 'usage limit reached', 'insufficient balance', 'quota exceeded', 'rate limit exceeded']
export const FREE_REFUSED_WHY = 'No free model answers now: today\'s free allowance is used up. Free models come back by themselves, at the latest when the provider\'s day turns over. To go on sooner, paste a free key on the Setup page (OpenRouter, NVIDIA, Google Gemini and others need no card), or sign in to Claude, Codex or Gemini there.'
