/**
 * What a new yard needs, and whether this computer has it.
 *
 * Each item says what it is for in plain words, its state, and how to fix it. Nothing here reads a
 * secret: a tool is asked for its own sign-in status, and a key is only ever "there" or "not there".
 * Botyard never types or stores a password. A fix is one of:
 *
 *   command   the tool's own sign-in or install, which Botyard can open in a terminal on this computer
 *   key       a key the person pastes; it goes to a file of its own in keysDir(), readable by them alone
 *   link      a page to open
 *
 * `setupState()` is `GET /api/studio/setup`, `setupAct(body)` is its `POST`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { crewDir, keysDir, studioRoot } from './home.mjs'
import { findCommand } from './timetable.mjs'

const CHECK_MS = 8_000
const REMEMBER_MS = 30_000
/** The engine keeps its store with Node's own SQLite, which this version brought. */
const NODE_NEEDED = [22, 13]
const KEY = /^[\x21-\x7e]{8,500}$/

/** The AI tools that run bots. `signedIn` answers true, false, or null when Botyard cannot tell. */
const TOOLS = [
  {
    id: 'opencode', name: 'OpenCode (free models)', command: 'opencode',
    what: 'Runs bots on free models. It needs no key and no account, so a new yard can work at once.',
    install: 'npm install -g opencode-ai',
    signedIn: async () => true,
    okDetail: 'Free models need no sign-in.',
  },
  {
    id: 'claude', name: 'Claude', command: 'claude',
    what: 'Runs the bots you put on Claude, on your own Claude plan.',
    install: 'npm install -g @anthropic-ai/claude-code', signIn: 'claude auth login',
    signedIn: async (p) => {
      // A token kept for the crew, or one the service was started with, is a sign-in too.
      if (p.env.CLAUDE_CODE_OAUTH_TOKEN || p.env.ANTHROPIC_API_KEY || p.exists(path.join(p.crew, 'claude-token'))) return true
      const out = await p.run('claude', ['auth', 'status'])
      try { return JSON.parse(out.stdout).loggedIn === true } catch { return out.code === 0 ? true : out.code === null ? null : false }
    },
  },
  {
    id: 'codex', name: 'Codex', command: 'codex',
    what: 'Runs the bots you put on Codex, on your own ChatGPT plan.',
    install: 'npm install -g @openai/codex', signIn: 'codex login',
    signedIn: async (p) => {
      if (p.env.OPENAI_API_KEY) return true
      const out = await p.run('codex', ['login', 'status'])
      return out.code === null ? null : out.code === 0
    },
  },
  {
    id: 'gemini', name: 'Gemini', command: 'gemini',
    what: 'Runs the bots you put on Gemini, on your own Google account.',
    install: 'npm install -g @google/gemini-cli', signIn: 'gemini',
    signInNote: 'Gemini asks you to sign in the first time it starts. Close it when it has.',
    signedIn: async (p) => Boolean(p.env.GEMINI_API_KEY || p.env.GOOGLE_API_KEY) || p.exists(path.join(p.home, '.gemini', 'oauth_creds.json')),
  },
  {
    id: 'antigravity', name: 'Antigravity', command: 'agy',
    what: 'Google\'s other coding tool. Bots can be moved to it while another AI is out of its limit.',
    installLink: 'https://antigravity.google', signIn: 'agy',
    signInNote: 'Antigravity asks you to sign in the first time it starts.',
    signedIn: async () => null,
  },
]

/** Optional keys. A key is there when it was pasted here, set where the service started, or added to OpenCode itself. */
const KEYS = [
  { id: 'openrouter', name: 'OpenRouter key', env: 'OPENROUTER_API_KEY', opencode: /openrouter/i, url: 'https://openrouter.ai/keys',
    what: 'Optional. Adds OpenRouter\'s free models to the ones your free bots can use.' },
  { id: 'nvidia', name: 'NVIDIA key', env: 'NVIDIA_API_KEY', opencode: /nvidia/i, url: 'https://build.nvidia.com',
    what: 'Optional. Adds NVIDIA\'s free hosted models to the ones your free bots can use.' },
]

const keyFile = (dir, id) => path.join(dir, `${id}.key`)
const version = (text) => /\d+\.\d+(\.\d+)?/.exec(String(text || ''))?.[0] || ''

/** What the checks ask the computer; a test hands in its own. */
export function probes({ env = process.env } = {}) {
  return {
    env,
    home: env.HOME || env.USERPROFILE || os.homedir(),
    crew: crewDir(env),
    keys: keysDir(env),
    studio: studioRoot(),
    nodeVersion: process.versions.node,
    which: (name) => findCommand(name, env),
    exists: (file) => fs.existsSync(file),
    /** Run a tool for its own answer. `code` is null when it could not be run or did not answer in time. */
    run: (name, args) => new Promise((resolve) => {
      const file = findCommand(name, env)
      if (!file) return resolve({ code: null, stdout: '' })
      // On Windows a tool installed by npm is a .cmd file, which Node starts only through the shell.
      // What is run is one of the fixed commands in this file, never anything a person typed.
      const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
      execFile(viaShell ? `"${file}"` : file, args, { timeout: CHECK_MS, env, windowsHide: true, maxBuffer: 1024 * 1024, shell: viaShell }, (err, stdout, stderr) => {
        if (err && (err.killed || typeof err.code !== 'number')) return resolve({ code: null, stdout: String(stdout || '') })
        resolve({ code: err ? err.code : 0, stdout: String(stdout || '') + String(stderr || '') })
      })
    }),
  }
}

const item = (id, name, group, needed, what, state, detail, fix = null) => ({ id, name, group, needed, state, what, detail, fix })
const command = (label, line) => ({ kind: 'command', label, command: line })

async function checkTool(tool, p) {
  if (!p.which(tool.command)) {
    const fix = tool.install ? command(`Install ${tool.name}`, tool.install) : { kind: 'link', label: `Get ${tool.name}`, url: tool.installLink }
    return item(tool.id, tool.name, 'ai', false, tool.what, 'missing', 'Not installed on this computer.', fix)
  }
  const [about, signed] = await Promise.all([p.run(tool.command, ['--version']), tool.signedIn(p).catch(() => null)])
  const found = `Found${version(about.stdout) ? `, version ${version(about.stdout)}` : ''}.`
  if (signed === true) return item(tool.id, tool.name, 'ai', false, tool.what, 'ok', `${found} ${tool.okDetail || 'Signed in.'}`)
  const fix = { ...command(`Sign in to ${tool.name}`, tool.signIn), ...(tool.signInNote ? { note: tool.signInNote } : {}) }
  if (signed === null) return item(tool.id, tool.name, 'ai', false, tool.what, 'unknown', `${found} Botyard cannot tell whether it is signed in: a bot's first run will say.`, fix)
  return item(tool.id, tool.name, 'ai', false, tool.what, 'signed-out', `${found} Not signed in.`, fix)
}

async function check(p) {
  const [major, minor] = p.nodeVersion.split('.').map(Number)
  const nodeOk = major > NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor >= NODE_NEEDED[1])
  const built = p.exists(path.join(p.studio, 'dist', 'index.html'))
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const [git, py, gh, ghAuth, providers, ...tools] = await Promise.all([
    p.which('git') ? p.run('git', ['--version']) : null,
    p.which(python) ? p.run(python, ['--version']) : null,
    p.which('gh') ? p.run('gh', ['--version']) : null,
    p.which('gh') ? p.run('gh', ['auth', 'status']) : null,
    // OpenCode's own list of the providers it holds a key for: names only.
    p.which('opencode') ? p.run('opencode', ['auth', 'list']) : null,
    ...TOOLS.map((tool) => checkTool(tool, p)),
  ])
  const items = [
    item('node', 'Node.js', 'needed', true, 'Botyard itself runs on it.', nodeOk ? 'ok' : 'missing',
      nodeOk ? `Version ${p.nodeVersion}.` : `Version ${p.nodeVersion} is too old: Botyard needs ${NODE_NEEDED.join('.')} or newer.`,
      nodeOk ? null : { kind: 'link', label: 'Get a newer Node.js', url: 'https://nodejs.org' }),
    item('git', 'Git', 'needed', true, 'Every job is done in a copy of your project and ends in a commit.', git ? 'ok' : 'missing',
      git ? `Found, version ${version(git.stdout)}.` : 'Not installed on this computer.',
      git ? null : { kind: 'link', label: 'Get Git', url: 'https://git-scm.com/downloads' }),
    item('map', 'The built map', 'needed', true, 'The page you see: built once from this folder.', built ? 'ok' : 'missing',
      built ? 'Built.' : 'Not built yet.', built ? null : command('Build the map', 'npm run build')),
    ...tools,
    item('github', 'GitHub', 'other', false, 'Lets the crew fetch your repositories and push finished work.',
      !gh ? 'missing' : ghAuth?.code === 0 ? 'ok' : ghAuth?.code === null ? 'unknown' : 'signed-out',
      !gh ? 'The GitHub tool (gh) is not installed.' : `Found, version ${version(gh.stdout)}. ${ghAuth?.code === 0 ? 'Signed in.' : ghAuth?.code === null ? 'It did not answer in time.' : 'Not signed in.'}`,
      !gh ? { kind: 'link', label: 'Get the GitHub tool', url: 'https://cli.github.com' } : ghAuth?.code === 0 ? null : command('Sign in to GitHub', 'gh auth login')),
    item('python', 'Python', 'other', false, 'Runs the crew\'s helper scripts: the checks, guards and timers.', py ? 'ok' : 'missing',
      py ? `Found, version ${version(py.stdout)}.` : 'Not installed. The map and the bots still work; the helpers do not run.',
      py ? null : { kind: 'link', label: 'Get Python', url: 'https://www.python.org/downloads/' }),
    ...KEYS.map((key) => {
      const where = p.exists(keyFile(p.keys, key.id)) ? 'Saved in Botyard.' : p.env[key.env] ? 'Set where the service was started.' : key.opencode.test(providers?.stdout || '') ? 'Added in OpenCode.' : ''
      return item(key.id, key.name, 'keys', false, key.what, where ? 'ok' : 'missing', where || 'No key yet. Free models work without it.',
        where ? null : { kind: 'key', label: `Paste a key for ${key.name.replace(/ key$/, '')}`, url: key.url })
    }),
  ]
  const state = (id) => items.find((entry) => entry.id === id).state
  const canRun = TOOLS.filter((tool) => state(tool.id) === 'ok').map((tool) => tool.name)
  const lacking = items.filter((entry) => entry.needed && entry.state !== 'ok').map((entry) => entry.name)
  const ready = !lacking.length && canRun.length > 0
  const summary = lacking.length ? `Botyard still needs: ${lacking.join(', ')}.`
    : !canRun.length ? 'No AI tool is ready yet. Install OpenCode to run bots on free models, or sign in to one of the others.'
    : `Ready. Bots can run on: ${canRun.join(', ')}.`
  return { ready, summary, checkedAt: Date.now(), items }
}

/**
 * A made-up computer, for pictures of the demo (`BOTYARD_SETUP=sample`): free models ready, GitHub
 * signed in, Claude installed but not signed in, Codex and Gemini not installed. The same checks
 * run over it, so the page is the real page; it just never shows what is on the computer that
 * took the picture.
 */
export function sampleProbe() {
  const tools = { git: '2.47.0', python3: '3.12.3', python: '3.12.3', opencode: '1.19.5', claude: '2.1.300', gh: '2.102.0' }
  const says = { 'claude auth status': { code: 1, stdout: '{"loggedIn":false}' }, 'gh auth status': { code: 0, stdout: 'Logged in' }, 'opencode auth list': { code: 0, stdout: '' } }
  const root = path.join(os.tmpdir(), 'botyard-sample-computer')
  return {
    env: {}, home: root, crew: path.join(root, 'crew'), keys: path.join(root, 'keys'), studio: studioRoot(), nodeVersion: '24.11.0',
    which: (name) => (name in tools ? `/usr/bin/${name}` : null),
    exists: (file) => file.endsWith(path.join('dist', 'index.html')),
    run: async (name, args) => says[[name, ...args].join(' ')] || { code: 0, stdout: `${name} ${tools[name] || ''}` },
  }
}
const sample = () => process.env.BOTYARD_SETUP === 'sample'

let remembered = null
/** The state of every item. Remembered for half a minute: each check starts a few small programs. */
export async function setupState({ fresh = false, probe = null } = {}) {
  if (probe) return check(probe)
  if (sample()) return check(sampleProbe())
  if (!fresh && remembered && Date.now() - remembered.checkedAt < REMEMBER_MS) return remembered
  remembered = await check(probes())
  return remembered
}

/**
 * Do one thing the setup page asks for → `[status, body]`.
 * `open(argv, cwd)` opens a terminal on this computer; the service hands in its own.
 */
export async function setupAct(body = {}, { probe = null, open = null } = {}) {
  // A made-up computer has nothing to sign in to and no key to keep.
  if (!probe && sample() && body?.action !== 'check') return [409, { error: 'This is the sample yard: its Setup is made up, so there is nothing to change here' }]
  const p = probe || (sample() ? sampleProbe() : probes())
  const again = async () => { remembered = null; return probe ? check(probe) : setupState({ fresh: true }) }
  const action = String(body?.action || '')
  const id = String(body?.id || '')
  if (action === 'check') return [200, await again()]

  if (action === 'key' || action === 'forget') {
    const key = KEYS.find((entry) => entry.id === id)
    if (!key) return [404, { error: 'Botyard keeps no key by that name' }]
    const file = keyFile(p.keys, id)
    if (action === 'forget') {
      fs.rmSync(file, { force: true })
      return [200, { ok: true, state: await again() }]
    }
    const value = typeof body.key === 'string' ? body.key.trim() : ''
    if (!KEY.test(value)) return [400, { error: 'That does not look like a key: paste it whole, with no spaces' }]
    // Written closed from the first byte, then moved into place, so it is never readable by others or half there.
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${value}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
    return [200, { ok: true, state: await again() }]
  }

  if (action === 'start') {
    const state = await (probe ? check(probe) : setupState())
    const entry = state.items.find((candidate) => candidate.id === id)
    if (!entry) return [404, { error: 'Setup has no item by that name' }]
    if (entry.fix?.kind !== 'command') return [400, { error: entry.fix ? 'This one is not fixed by a command' : `${entry.name} needs nothing done` }]
    const line = entry.fix.command
    const [name, ...args] = line.split(' ')
    const file = p.which(name)
    const note = entry.fix.note || ''
    if (!file) return [200, { ok: true, opened: false, command: line, note: `${name} is not on this computer, so Botyard cannot start it. Install it, then run the command.` }]
    const opener = open || (await import('./open-terminal.mjs')).openTerminal
    const shown = await opener([file, ...args], id === 'map' ? p.studio : p.home).catch((err) => ({ ok: false, error: err.message }))
    remembered = null
    if (shown?.ok) return [200, { ok: true, opened: true, command: line, note: note || 'A terminal has opened on the computer. Finish there, then check again.' }]
    return [200, { ok: true, opened: false, command: line, note: 'No terminal could be opened on the computer. Run the command there yourself, then check again.' }]
  }
  return [400, { error: 'Unknown action: use check, start, key or forget' }]
}
