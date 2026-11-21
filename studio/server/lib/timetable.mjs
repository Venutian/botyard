/**
 * The timetable: Botyard runs the crew's helper scripts itself, on their times, inside the service.
 *
 * What runs and when is data, `crew/timetable.json`: timers (every so often, or at a time of day)
 * and keepers (small servers that are kept running). The rules here are the same for every job:
 *
 *   - a job never overlaps itself, not even across a restart of the service (a pid file per job);
 *   - a run has a time limit, and is stopped when it passes it;
 *   - what a run printed goes to `runLogs()/timetable/<name>.log`, trimmed so it never grows;
 *   - a failure is written to the service's log and shown on the page, with the run's last line.
 *
 * The whole timetable is `on` or `off`, and so is each job; that choice is kept in
 * `home()/timetable-state.json`.
 *
 * A yard adds helpers of its own without touching the tree: scripts in `crewDir()/own/`, listed in
 * `crewDir()/own/timetable.json` in the same shape (`{own}` in a command is that folder). An own
 * job with the name of one of the tree's replaces it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { HELPER } from './heavy.mjs'
import { configDir, crewDir, crewScripts, home, repoRoot, runLogs, studioRoot } from './home.mjs'

const TICK_MS = 5_000
const KILL_WAIT_MS = 10_000
const LOG_MAX = 256 * 1024
const LOG_KEEP = 128 * 1024
const LOG_SHOWN = 64 * 1024
const KEEPER_RESTART_MS = 5_000
const KEEPER_MAX_WAIT_MS = 5 * 60_000
/** A keeper that stays up this long had a real run: the wait before its next start goes back to the shortest. */
const KEEPER_SETTLED_MS = 60_000
const DEFAULT_LIMIT_MS = 10 * 60_000
const NAME = /^[a-z][a-z0-9-]{0,39}$/
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "30s", "5m", "1h" as milliseconds; anything else is a mistake in the data file. */
export function parseSpan(text) {
  const match = /^(\d+)\s*([smhd])$/.exec(String(text ?? '').trim())
  if (!match || !Number(match[1])) throw new Error(`"${text}" is not a length of time (write 30s, 5m or 1h)`)
  return Number(match[1]) * UNITS[match[2]]
}

/** A length of time in words: "5 minutes", "1 hour". */
export function spanWords(ms) {
  for (const [unit, size] of [['day', UNITS.d], ['hour', UNITS.h], ['minute', UNITS.m], ['second', UNITS.s]]) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${unit}${ms / size === 1 ? '' : 's'}`
  }
  return `${Math.round(ms / 1000)} seconds`
}

/** "Mon 08:00", "04:30", "*:05,35" → { day: 0-6 | null, hour: 0-23 | null, minutes: [..] }. */
export function parseAt(text) {
  const match = /^(?:(sun|mon|tue|wed|thu|fri|sat)\w*\s+)?(\*|\d{1,2}):(\d{1,2}(?:,\d{1,2})*)$/i.exec(String(text ?? '').trim())
  if (!match) throw new Error(`"${text}" is not a time (write 04:30, Mon 08:00 or *:05,35)`)
  const hour = match[2] === '*' ? null : Number(match[2])
  const minutes = [...new Set(match[3].split(',').map(Number))].sort((a, b) => a - b)
  if ((hour !== null && hour > 23) || minutes.some((minute) => minute > 59)) throw new Error(`"${text}" is not a time of day`)
  return { day: match[1] ? DAYS.indexOf(match[1].toLowerCase()) : null, hour, minutes }
}

/** The first moment after `from` that the time comes round, by this computer's clock. */
export function nextAt(at, from) {
  const start = new Date(from)
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + ahead)
    if (at.day !== null && day.getDay() !== at.day) continue
    for (const hour of at.hour === null ? [...Array(24).keys()] : [at.hour]) {
      for (const minute of at.minutes) {
        const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime()
        if (when > from) return when
      }
    }
  }
  return null
}

const two = (n) => String(n).padStart(2, '0')
function whenWords(job) {
  if (job.kind === 'keeper') return 'always on'
  if (job.everyMs) return job.everyMs === UNITS.m ? 'every minute' : job.everyMs === UNITS.h ? 'every hour' : `every ${spanWords(job.everyMs)}`
  const { day, hour, minutes } = job.at
  if (hour === null) return `every hour at ${minutes.map((minute) => `:${two(minute)}`).join(' and ')}`
  const times = minutes.map((minute) => `${two(hour)}:${two(minute)}`).join(' and ')
  return day === null ? `every day at ${times}` : `${DAY_NAMES[day]} at ${times}`
}

/** KEY=value lines of an environment file. Its values are passed to the job and never shown. */
export function readEnvFile(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || line.trim().startsWith('#')) continue
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** Where a command is, looked for the way a shell does; null when this computer does not have it. */
export function findCommand(name, env = process.env) {
  if (!name) return null
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : ['']
  const runnable = (file) => {
    try { if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
  }
  const dirs = name.includes('/') || name.includes(path.sep) ? [''] : (env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) for (const ext of exts) {
    const file = dir ? path.join(dir, name + ext) : name + ext
    if (runnable(file)) return file
  }
  return null
}

/** The data file, checked: a mistake in it is said in plain words with the job's name. */
export function readTimetable(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.jobs
  if (!Array.isArray(list)) throw new Error('The timetable file needs a "jobs" list')
  const seen = new Set()
  return list.map((entry, index) => {
    const name = String(entry?.name || '')
    const fail = (why) => { throw new Error(`Timetable job ${name || `number ${index + 1}`}: ${why}`) }
    if (!NAME.test(name)) fail('its name must be lower-case letters, digits and dashes')
    if (seen.has(name)) fail('the name is used twice')
    seen.add(name)
    if (!Array.isArray(entry.command) || !entry.command.length || entry.command.some((part) => typeof part !== 'string' || !part)) fail('"command" must be a list of words')
    const kind = entry.kind === 'keeper' ? 'keeper' : 'timer'
    const job = {
      name, kind, what: String(entry.what || ''), command: entry.command, cwd: entry.cwd || '{repo}',
      envFile: entry.envFile || '', on: entry.on !== false, nice: Number(entry.nice) || 0, leaveChildren: entry.leaveChildren === true,
    }
    try {
      if (kind === 'keeper') {
        job.restartMs = entry.restart ? parseSpan(entry.restart) : KEEPER_RESTART_MS
      } else {
        if (Boolean(entry.every) === Boolean(entry.at)) fail('needs one of "every" or "at"')
        if (entry.every) {
          job.everyMs = parseSpan(entry.every)
          job.after = entry.after === 'start' ? 'start' : 'finish'
          job.firstMs = entry.first ? parseSpan(entry.first) : job.everyMs
        } else {
          job.at = parseAt(entry.at)
          job.catchUp = entry.catchUp === true
        }
        job.limitMs = entry.limit ? parseSpan(entry.limit) : DEFAULT_LIMIT_MS
      }
    } catch (err) {
      if (String(err.message).startsWith('Timetable job')) throw err
      fail(err.message)
    }
    return job
  })
}

/**
 * The tree's jobs with a yard's own laid over them: an own job replaces the tree's job of the same
 * name where it stood, and the rest of the own jobs follow. Each job says whether it is the yard's own.
 */
export function withOwn(tree, own) {
  const mine = new Map(own.map((job) => [job.name, { ...job, own: true }]))
  const out = tree.map((job) => mine.get(job.name) || { ...job, own: false })
  const taken = new Set(tree.map((job) => job.name))
  return [...out, ...[...mine.values()].filter((job) => !taken.has(job.name))]
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 1))
  fs.renameSync(temporary, file)
}

/** Keep the end of a log that has grown past its size, cut at a line. */
export function trimLog(file, max = LOG_MAX, keep = LOG_KEEP) {
  let size
  try { size = fs.statSync(file).size } catch { return }
  if (size <= max) return
  const buffer = Buffer.alloc(keep)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buffer, 0, keep, size - keep) } finally { fs.closeSync(fd) }
  const cut = buffer.indexOf(10)
  fs.writeFileSync(file, Buffer.concat([Buffer.from('(earlier output trimmed)\n'), buffer.subarray(cut + 1)]))
}

function tail(file, bytes) {
  try {
    const size = fs.statSync(file).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buffer, 0, length, size - length) } finally { fs.closeSync(fd) }
    return buffer.toString('utf8')
  } catch { return '' }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
/** Is this pid still the job we started? A pid alone is not proof: the number may belong to something new by now. */
function stillOurs(pid, mark) {
  if (!alive(pid)) return false
  if (process.platform !== 'linux') return true
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(mark) } catch { return false }
}

/**
 * One timetable. Nothing runs until `start()`.
 *
 * @param {object} options
 * @param {string} options.file        the data file (crew/timetable.json)
 * @param {string} [options.ownFile]   a yard's own jobs, laid over the tree's (missing is fine)
 * @param {string} options.stateFile   where on/off and each job's last run are kept
 * @param {string} options.logDir      one log per job
 * @param {Record<string,string>} [options.vars]  what {name} in a command stands for
 * @param {object} [options.env]       what a job is told, on top of the service's own environment
 * @param {'on'|'off'|''} [options.force]  a state that overrides the saved one (for the service's own flag)
 * @param {string} [options.locked]  why nothing may run here (the sample yard): every helper is listed with its times and its last run, none is started, and no choice is changed
 */
export function createTimetable({ file, ownFile = '', stateFile, logDir, vars = {}, env = {}, force = '', locked = '', now = Date.now, spawn = nodeSpawn, log = console.log, tickMs = TICK_MS } = {}) {
  let jobs = []
  let problem = ''
  try { jobs = readTimetable(file) } catch (err) { problem = err.code === 'ENOENT' ? 'There is no timetable file' : `The timetable file could not be read: ${err.message}` }
  // A mistake in a yard's own file is said, and never stops the helpers that came with Botyard.
  let ownProblem = ''
  if (ownFile && !problem) {
    try { jobs = withOwn(jobs, readTimetable(ownFile)) } catch (err) {
      if (err.code !== 'ENOENT') ownProblem = `Your own timetable (${ownFile}) could not be read, so only the helpers that came with Botyard are listed: ${err.message}`
      jobs = withOwn(jobs, [])
    }
  } else jobs = withOwn(jobs, [])
  const saved = readJson(stateFile, {})
  saved.jobs ||= {}
  saved.last ||= {}
  const live = new Map(jobs.map((job) => [job.name, { running: false, child: null, pid: 0, foreign: false, nextAt: null, runs: 0, failures: 0, quick: 0, stopping: false, ...(saved.last[job.name] || {}) }]))
  let timer = null
  let startedAt = 0
  fs.mkdirSync(logDir, { recursive: true })

  const fill = (text) => String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key] : whole))
  const save = () => {
    saved.last = Object.fromEntries([...live].map(([name, s]) => [name, { lastStart: s.lastStart ?? null, lastEnd: s.lastEnd ?? null, lastOk: s.lastOk ?? null, lastError: s.lastError || '' }]))
    try { writeJson(stateFile, saved) } catch (err) { log(`[timetable] could not save its state: ${err.message}`) }
  }
  const master = () => {
    if (problem) return { state: 'off', why: problem }
    if (locked) return { state: 'off', why: locked }
    if (force === 'on' || force === 'off') return { state: force, why: `Set ${force} where the service was started.` }
    if (saved.state === 'off') return { state: 'off', why: ['Turned off here. A helper can still be run by hand.', ownProblem].filter(Boolean).join(' ') }
    return { state: 'on', why: ownProblem }
  }
  const isOn = (job) => saved.jobs[job.name]?.on ?? job.on
  const pidFile = (job) => path.join(logDir, `${job.name}.pid`)
  const logFile = (job) => path.join(logDir, `${job.name}.log`)

  /** Why a job cannot run on this computer, or '' when it can. */
  function notReady(job) {
    const parts = job.command.map(fill)
    const isPath = parts[0].includes('/') || parts[0].includes(path.sep)
    if (!findCommand(parts[0], { ...process.env, ...env })) return isPath ? `${path.basename(parts[0])} is not on this computer` : `${parts[0]} is not installed`
    for (let i = 1; i < parts.length; i++) {
      if (/^\{(scripts|own|repo|studio|crew)\}[\\/]/.test(job.command[i]) && !fs.existsSync(parts[i])) return `${path.basename(parts[i])} is not there`
    }
    if (job.envFile && !fs.existsSync(fill(job.envFile))) return 'Not set up on this computer yet'
    return ''
  }

  function schedule(job, s, from = now()) {
    if (job.kind !== 'timer') { s.nextAt = null; return }
    if (job.at) { s.nextAt = nextAt(job.at, from); return }
    const base = job.after === 'start' ? s.lastStart : s.lastEnd
    s.nextAt = Math.max(from, (base ?? from) + job.everyMs)
  }

  function kill(job, s, signal) {
    if (!s.pid) return
    // A job is its own process group, so what it started stops with it; a keeper that looks after
    // runs of its own is stopped alone and its runs are left to finish.
    const whole = !job.leaveChildren && process.platform !== 'win32' && !s.foreign
    try { process.kill(whole ? -s.pid : s.pid, signal) } catch { /* already gone */ }
  }

  function finish(job, s, ok, error) {
    const ended = now()
    s.running = false
    s.child = null
    s.pid = 0
    s.foreign = false
    clearTimeout(s.limitTimer)
    clearTimeout(s.killTimer)
    s.lastEnd = ended
    s.lastOk = ok
    s.lastError = ok ? '' : error
    if (!ok) s.failures++
    try { fs.rmSync(pidFile(job), { force: true }) } catch { /* nothing to clear */ }
    try {
      fs.appendFileSync(logFile(job), `--- ${new Date(ended).toISOString()} ${ok ? 'finished' : `failed: ${error}`} (${spanWords(Math.max(1000, Math.round((ended - s.lastStart) / 1000) * 1000))})\n`)
      trimLog(logFile(job))
    } catch { /* the log is a help, not a need */ }
    if (!ok && !s.stopping) log(`[timetable] ${job.name} failed: ${error}`)
    if (job.kind === 'keeper') {
      // A keeper that keeps falling over waits longer each time, so a broken one does not spin.
      s.quick = ended - s.lastStart < KEEPER_SETTLED_MS ? s.quick + 1 : 0
      s.nextAt = ended + Math.min(KEEPER_MAX_WAIT_MS, job.restartMs * 2 ** Math.min(s.quick, 8))
    } else {
      schedule(job, s, ended)
    }
    s.stopping = false
    save()
  }

  /** Start one run. Returns '' when it started, else why it did not. */
  function run(job, s) {
    if (s.running) return 'It is already running'
    const why = notReady(job)
    if (why) return why
    const before = readJson(pidFile(job), null)
    const mark = path.basename(fill(job.command.find((part) => /^\{(scripts|own|repo)\}/.test(part)) || job.command[0]))
    if (before?.pid && stillOurs(before.pid, mark)) {
      // Started before the service was restarted, and still going: it is the run, not a second one.
      Object.assign(s, { running: true, foreign: true, pid: before.pid, lastStart: before.at || now() })
      return 'It is still running from before the service restarted'
    }
    const [command, ...args] = job.command.map(fill)
    const started = now()
    let out
    try {
      fs.appendFileSync(logFile(job), `--- ${new Date(started).toISOString()} started\n`)
      out = fs.openSync(logFile(job), 'a')
    } catch (err) { return `Its log could not be opened: ${err.message}` }
    let child
    try {
      const extra = job.envFile ? readEnvFile(fill(job.envFile)) : {}
      const file = findCommand(command, { ...process.env, ...env }) || command
      // On Windows a tool installed by npm is a .cmd file, which is only started through the shell.
      const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
      // BOTYARD_HELPER names the helper on its processes, for what runs now (lib/heavy.mjs).
      child = spawn(viaShell ? `"${file}"` : file, viaShell ? args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args, {
        shell: viaShell,
        cwd: fill(job.cwd), env: { ...process.env, ...env, ...extra, [HELPER]: job.name }, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: true,
      })
    } catch (err) {
      fs.closeSync(out)
      return `It could not be started: ${err.message}`
    }
    fs.closeSync(out)
    Object.assign(s, { running: true, child, pid: child.pid || 0, foreign: false, lastStart: started, lastEnd: null, runs: s.runs + 1, stopping: false })
    if (child.pid) {
      try { writeJson(pidFile(job), { pid: child.pid, at: started }) } catch { /* overlap is still held in memory */ }
      if (job.nice) { try { os.setPriority(child.pid, job.nice) } catch { /* runs at the usual priority */ } }
    }
    let over = false
    if (job.kind === 'timer') {
      s.limitTimer = setTimeout(() => {
        over = true
        kill(job, s, 'SIGTERM')
        s.killTimer = setTimeout(() => kill(job, s, 'SIGKILL'), KILL_WAIT_MS)
        s.killTimer.unref?.()
      }, job.limitMs)
      s.limitTimer.unref?.()
    }
    let done = false
    const end = (code, signal, failure) => {
      if (done) return
      done = true
      if (failure) return finish(job, s, false, `It could not be started: ${failure.message}`)
      if (over) return finish(job, s, false, `Stopped after ${spanWords(job.limitMs)}: over its time limit`)
      if (s.stopping) return finish(job, s, true, '')
      if (job.kind === 'keeper') return finish(job, s, false, `It stopped${code ? ` with exit code ${code}` : signal ? ` on ${signal}` : ''}${lastLine(job)}`)
      if (code === 0) return finish(job, s, true, '')
      finish(job, s, false, `${signal ? `Ended by ${signal}` : `Exit code ${code}`}${lastLine(job)}`)
    }
    child.once('error', (err) => end(null, null, err))
    child.once('exit', (code, signal) => end(code, signal))
    return ''
  }

  /** The last thing a run said, for the page: a line, cut short. */
  function lastLine(job) {
    const lines = tail(logFile(job), 4096).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('--- '))
    const line = lines.at(-1)
    return line ? `: ${line.slice(0, 300)}` : ''
  }

  function tick() {
    const { state } = master()
    for (const job of jobs) {
      const s = live.get(job.name)
      if (s.foreign && !stillOurs(s.pid, '')) finish(job, s, true, '')
      if (s.running) continue
      if (state !== 'on' || !isOn(job)) continue
      if (s.nextAt === null || now() < s.nextAt) continue
      const why = run(job, s)
      // Not ready (a script that is not there): look again later without filling the log.
      if (why && !s.running) s.nextAt = now() + Math.max(tickMs, 60_000)
    }
  }

  function arm() {
    startedAt = now()
    for (const job of jobs) {
      const s = live.get(job.name)
      if (job.kind === 'keeper') { s.nextAt = startedAt; continue }
      if (job.at) {
        // A time that came round while the service was off is run now, where the job asks for that.
        const missed = job.catchUp && s.lastStart && nextAt(job.at, s.lastStart) <= startedAt
        s.nextAt = missed ? startedAt : nextAt(job.at, startedAt)
      } else {
        s.nextAt = startedAt + job.firstMs
      }
    }
  }

  function view() {
    const { state, why } = master()
    return {
      state, why,
      jobs: jobs.map((job) => {
        const s = live.get(job.name)
        const missing = notReady(job)
        const on = isOn(job)
        return {
          name: job.name, kind: job.kind, what: job.what, own: job.own, when: whenWords(job), ...(job.kind === 'timer' ? { limit: spanWords(job.limitMs) } : {}),
          on, ready: !missing, notReady: missing, running: s.running,
          lastStart: s.lastStart ?? null, lastEnd: s.lastEnd ?? null, lastOk: s.lastOk ?? null, lastError: s.lastError || '',
          // A locked list still says when each helper would next run: that is what the list is for.
          nextAt: (locked ? on : state === 'on' && on && !missing && timer) && !s.running ? s.nextAt : null,
          runs: s.runs, failures: s.failures,
        }
      }),
    }
  }

  return {
    jobs: () => jobs,
    start() {
      if (timer) return
      arm()
      if (locked) { log(`[timetable] listed, not run: ${locked}`); return }
      timer = setInterval(tick, tickMs)
      timer.unref?.()
      const { state, why } = master()
      log(`[timetable] ${state}${why ? `: ${why}` : `, ${jobs.length} helpers`}`)
      tick()
    },
    /** Stop looking at the clock and stop what is running; resolves when every run has ended. */
    async stop({ waitMs = 5000 } = {}) {
      clearInterval(timer)
      timer = null
      const running = jobs.filter((job) => live.get(job.name).running && !live.get(job.name).foreign)
      for (const job of running) { const s = live.get(job.name); s.stopping = true; kill(job, s, 'SIGTERM') }
      const until = Date.now() + waitMs
      while (running.some((job) => live.get(job.name).running) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
      for (const job of running) if (live.get(job.name).running) kill(job, live.get(job.name), 'SIGKILL')
    },
    tick,
    state: view,
    logOf(name) {
      const job = jobs.find((entry) => entry.name === name)
      return job ? { name, log: tail(logFile(job), LOG_SHOWN) } : null
    },
    act(body = {}) {
      if (locked) return [409, { error: locked }]
      const action = String(body.action || '')
      const name = body.name === undefined || body.name === '' ? '' : String(body.name)
      const job = name ? jobs.find((entry) => entry.name === name) : null
      if (name && !job) return [404, { error: `The timetable has no helper called ${name.slice(0, 60)}` }]
      if (action === 'on' || action === 'off') {
        if (job) {
          saved.jobs[job.name] = { on: action === 'on' }
          const s = live.get(job.name)
          if (action === 'off' && job.kind === 'keeper' && s.running) { s.stopping = true; kill(job, s, 'SIGTERM') }
          if (action === 'on' && !s.running) { if (job.kind === 'keeper') s.nextAt = now(); else if (s.nextAt === null || s.nextAt < now()) schedule(job, s) }
        } else {
          if (problem) return [409, { error: problem }]
          saved.state = action
          if (action === 'off') for (const keeper of jobs.filter((entry) => entry.kind === 'keeper')) { const s = live.get(keeper.name); if (s.running) { s.stopping = true; kill(keeper, s, 'SIGTERM') } }
          else if (timer) arm()
        }
        save()
        return [200, view()]
      }
      if (action === 'run') {
        if (!job) return [400, { error: 'Say which helper to run' }]
        const s = live.get(job.name)
        if (s.running) return [409, { error: `${job.name} is already running` }]
        const why = run(job, s)
        if (why) return [409, { error: `${job.name} was not started. ${why}` }]
        return [200, view()]
      }
      return [400, { error: 'Unknown action: use on, off or run' }]
    },
  }
}

/** The timetable of this process, once the service has started one. */
let current = null

/** Start this process's timetable with Botyard's own folders. `env` is what each job is told. */
export function startTimetable({ env = {}, force = process.env.BOTYARD_TIMETABLE || '', file = process.env.BOTYARD_TIMETABLE_FILE || path.join(crewScripts(), 'timetable.json'), log = console.log, ...rest } = {}) {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const own = path.join(crewDir(), 'own')
  current = createTimetable({
    file,
    ownFile: path.join(own, 'timetable.json'),
    stateFile: path.join(home(), 'timetable-state.json'),
    logDir: path.join(runLogs(), 'timetable'),
    vars: { python, node: process.execPath, scripts: crewScripts(), own, repo: repoRoot(), studio: studioRoot(), crew: crewDir(), home: home(), config: configDir() },
    env, force, log, ...rest,
  })
  current.start()
  return current
}

const NONE = { state: 'off', why: 'Helpers are off in this copy of Botyard (a demo or a test). They run when Botyard is started with npm start.', jobs: [] }
/** `GET /api/studio/timetable`: the whole timetable; with `log` a job's name, that job's last output. */
export function timetableState({ log = '' } = {}) {
  if (!current) return log ? null : NONE
  return log ? current.logOf(String(log)) : current.state()
}
/** `POST /api/studio/timetable`: `{ action: 'on' | 'off' | 'run', name? }` → `[status, body]`. */
export function timetableAct(body) {
  if (!current) return [409, { error: NONE.why }]
  return current.act(body)
}
/** For the service on its way down, and for tests. */
export async function stopTimetable() {
  const mine = current
  current = null
  await mine?.stop()
}
