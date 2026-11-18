/**
 * Who is calling the engine's port, and what each caller may do.
 *
 * Three callers, told apart by what they send:
 * - a bot in a run sends its run's pass (`Authorization: Bearer <pass>`), and is that bot;
 * - the owner's own side (the page server, the map's API, the phone's door) sends the owner key
 *   (`X-Botyard-Key`, from `keys/engine-owner.key`), and is the owner;
 * - a crew script sends the scripts key (`keys/engine-scripts.key`) and its own name
 *   (`X-Botyard-Script`), and is `script:<name>`: its comments and jobs show as that script.
 *
 * A call with none of these used to be the owner. The keys roll out in two steps, so the crew never
 * stops: in "log" mode such a call is still the owner, and the engine writes down which process made
 * it (`engine-callers.log` in its data folder); in "enforce" mode, the default, it is refused. The mode
 * comes from `BOTYARD_ENGINE_KEYS` (log | enforce).
 *
 * Only the owner answers a card or changes Botyard's settings. A script may seed a bot's settings and
 * instructions from the crew's files, as the owner may; a bot may not.
 *
 * Both key files are made on the first start, readable by this user alone (0600). The owner key never
 * goes into a run's environment; the bots' guard refuses reading it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RUN_VARS } from './names.mjs'
import { Refused } from './write.mjs'

export const OWNER = 'local-board'
export const OWNER_KEY_FILE = 'engine-owner.key'
export const SCRIPTS_KEY_FILE = 'engine-scripts.key'
export const KEY_HEADER = 'x-botyard-key'
export const SCRIPT_HEADER = 'x-botyard-script'
export const MODES = new Set(['log', 'enforce'])
const SCRIPT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Whether a call with no pass and no key is refused ('enforce', the default) or still answered as the owner
 * and written down ('log', for a studio whose own scripts do not send the scripts key yet).
 */
export function keyMode(env = process.env) {
  const told = String(env.BOTYARD_ENGINE_KEYS || '').trim().toLowerCase()
  return MODES.has(told) ? told : 'enforce'
}

function readKey(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

/** Make the key file when it is missing (0600, in a 0700 folder) and return its key. */
function ensureKey(dir, name) {
  const file = path.join(dir, name)
  const had = readKey(file)
  if (had) return had
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const made = crypto.randomBytes(32).toString('base64url')
  try {
    fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return readKey(file)
  }
  return made
}

/** The two keys, made when missing. */
export function ensureKeys(keysDir) {
  return { owner: ensureKey(keysDir, OWNER_KEY_FILE), scripts: ensureKey(keysDir, SCRIPTS_KEY_FILE) }
}

const ownerKeyCache = new Map()
/** The header the owner's own side sends to the engine's port: {} when there is no key yet. */
export function ownerKeyHeaders(keysDir) {
  if (!keysDir) return {}
  let key = ownerKeyCache.get(keysDir)
  if (!key) {
    key = readKey(path.join(keysDir, OWNER_KEY_FILE))
    if (key) ownerKeyCache.set(keysDir, key)
  }
  return key ? { [KEY_HEADER]: key } : {}
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * What a call to the port says about its caller, before any pass is checked:
 * `{ kind: 'owner' }`, `{ kind: 'script', script }`, `{ kind: 'pass' }` (a bot's pass: the engine
 * checks it), `{ kind: 'none' }`, or `{ kind: 'wrong' }` for a key that is neither.
 */
export function callerOf(headers = {}, keys = {}) {
  if (/^Bearer\s+\S+$/i.test(String(headers.authorization || ''))) return { kind: 'pass' }
  const key = headers[KEY_HEADER]
  if (!key) return { kind: 'none' }
  if (same(key, keys.owner)) return { kind: 'owner' }
  if (same(key, keys.scripts)) {
    const told = String(headers[SCRIPT_HEADER] || '').trim().toLowerCase().replace(/\.(py|sh|mjs|js)$/, '')
    return { kind: 'script', script: SCRIPT_NAME.test(told) ? told : 'unnamed' }
  }
  return { kind: 'wrong' }
}

/** The actor a call with no pass is, by its caller. null when it is refused. */
export function actorOf(caller, mode) {
  if (!caller || caller.kind === 'owner') return { user: OWNER }
  if (caller.kind === 'probe') return { user: 'health-check', probe: true }
  if (caller.kind === 'script') return { user: `script:${caller.script}`, script: caller.script, mode }
  if (caller.kind === 'none' && mode !== 'enforce') return { user: OWNER, unkeyed: true }
  return null
}

let warn = () => {}
/** Where a "would refuse" line goes while the keys are being rolled out. */
export function onWouldRefuse(fn) { warn = typeof fn === 'function' ? fn : () => {} }

/** Only the owner does this. A script is refused once the keys are enforced; before that, it is written down. */
export function ownerOnly(actor, what) {
  if (actor?.agent) throw new Refused(403, `Only the owner ${what}`)
  if (actor?.script) {
    if (actor.mode === 'enforce') throw new Refused(403, `Only the owner ${what}; a script may not`)
    warn(`script:${actor.script} ${what} (allowed while the keys are rolled out; refused once they are enforced)`)
  }
}

/** The owner, or a crew script seeding from the crew's files. Never a bot. */
export function ownerOrScript(actor, what) {
  if (actor?.agent) throw new Refused(403, `Only the owner ${what}`)
}

// ── which process made a call with no key ─────────────────────────────────────────────

const hexPort = (port) => Number(port).toString(16).toUpperCase().padStart(4, '0')

/** The inode of the loopback socket whose local port is `port`, read from /proc. '' off Linux. */
function socketInode(port, enginePort) {
  const mine = `:${hexPort(port)}`
  const theirs = `:${hexPort(enginePort)}`
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = fs.readFileSync(table, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length > 9 && cols[1].endsWith(mine) && cols[2].endsWith(theirs)) return cols[9]
    }
  }
  return ''
}

/** The process on this computer that holds the far end of a loopback call, or '' when it cannot be told. */
export function pidOf(port, serverPort) {
  const inode = socketInode(port, serverPort)
  if (!inode || inode === '0') return ''
  const want = `socket:[${inode}]`
  let pids = []
  try { pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)) } catch { return '' }
  for (const pid of pids) {
    let fds = []
    try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      let link = ''
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { continue }
      if (link === want) return pid
    }
  }
  return ''
}

/** The command line of the process on this computer that holds the socket, or '' when it cannot be told. */
export function processOf(port, enginePort) {
  const pid = pidOf(port, enginePort)
  if (!pid) return ''
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    return `${pid} ${cmd.join(' ')}`.slice(0, 300)
  } catch { return pid }
}

/** The variables that say a process runs for a bot: every run is told its own run id and pass. */
const RUN_MARKS = [RUN_VARS.runId, RUN_VARS.apiKey]

/**
 * The bot run behind a process, if any: the run id of the nearest process up its family that was
 * started as a bot's run, or ''. A bot cannot shed this by calling through curl or a script it starts,
 * since each child keeps its parent's variables unless it clears them, and the parents are read too.
 */
export function botRunOf(pid, { proc = '/proc', depth = 12 } = {}) {
  let at = String(pid || '')
  for (let i = 0; at && at !== '0' && at !== '1' && i < depth; i += 1) {
    let vars = []
    try { vars = fs.readFileSync(path.join(proc, at, 'environ'), 'utf8').split('\0') } catch { return '' }
    for (const name of RUN_MARKS) {
      const line = vars.find((v) => v.startsWith(`${name}=`))
      if (line && line.length > name.length + 1) return line.slice(name.length + 1) || 'a run'
    }
    try { at = fs.readFileSync(path.join(proc, at, 'stat'), 'utf8').split(') ').pop().split(' ')[1] } catch { return '' }
  }
  return ''
}

/** Did a bot's run make this call on this computer? Says which run, or ''. */
export function botBehind(req, options = {}) {
  const pid = options.pid ?? pidOf(req.socket?.remotePort, req.socket?.localPort)
  return pid ? botRunOf(pid, options) : ''
}

const seen = new Map()
const SEEN_MS = 10 * 60 * 1000
/**
 * Write down a call that came with no key (or no JSON), once per process and path shape every ten
 * minutes, so the log says which of the crew's scripts still need the key.
 */
export function logUnkeyed(file, { req, why, enginePort, now = Date.now() }) {
  const shape = String(req.url || '').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/[A-Z]+-\d+/g, '/:code')
  const who = processOf(req.socket?.remotePort, enginePort) || String(req.headers['user-agent'] || 'unknown').slice(0, 80)
  const proc = who.replace(/^\d+ /, '')
  const id = `${why}|${proc}|${req.method}|${shape}`
  if (now - (seen.get(id) || 0) < SEEN_MS) return
  seen.set(id, now)
  if (seen.size > 2000) for (const [k, at] of seen) if (now - at > SEEN_MS) seen.delete(k)
  const line = JSON.stringify({ at: new Date(now).toISOString(), why, method: req.method, path: shape, who, agent: req.headers['user-agent'] || '' })
  try { fs.appendFileSync(file, `${line}\n`) } catch { /* the log is a help, never a reason to fail a call */ }
}
