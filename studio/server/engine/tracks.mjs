/**
 * Tracks: the way a job moves, kept as data and run by the engine (docs/tracks.md).
 *
 * A track is saved as steps and the lines between them. A request is the job someone asked for; a
 * trip is one run of a track for it. On every turn the engine moves each trip on: a step whose needs
 * are there is started, a step that ended is booked as a snapshot, and the line its outcome names is
 * taken. A failed check goes back along its back-line with the findings, up to its rounds, and then to
 * its `then` step. A request that delivers a change is finished only when its commit is in main.
 *
 * Steps are one of four kinds: a bot (a job for a bot under the request), a script (a plain command
 * run by its own keeper, so it outlives a restart), a gate (the owner decides) and another track.
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ownerOnly, ownerOrScript } from './caller.mjs'
import { Refused, createCard, createJob, note, patchJob, settleCard } from './write.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const exec = promisify(execFile)
const iso = (now) => new Date(now).toISOString()
const ENGINE = { user: 'engine:tracks' }

export const STEP_KINDS = ['bot', 'script', 'gate', 'track']
export const LINE_ON = ['pass', 'fail', 'always']
/** What a request gives every trip without saying so. */
export const GIVEN = ['title', 'words']
/** What a step may be handed besides what it needs: the last check's findings, the owner's note, the work it continues. */
export const HANDED = ['findings', 'note', 'base']
const NAME = /^[a-z][a-z0-9_-]{0,39}$/
/** The last line of every job a bot step makes: the crew's own scripts leave such a job to its track. */
export const TRACK_MARK = 'TRACK STEP:'
/** Small tools a track's script steps may call: `node "$BOTYARD_TRACK_TOOLS/land.mjs"`. */
export const TRACK_TOOLS = path.join(here, 'track-tools')
const MOST_STEPS = 40
const MOST_ROUNDS = 20
const VALUE_CHARS = 20_000
const LOST_AFTER_MS = 20_000
/** Trips still moving: the engine looks at these on every turn. */
const MOVING = ['running', 'not-in-main']

/** What the track runner does outside the store. Replaced in tests. */
export const trackIo = {
  /** Start a script step's keeper (the same keeper a bot's run has) and let go of it. */
  startKeeper(specFile) {
    const keeper = spawn(process.execPath, [path.join(here, 'run-one.mjs'), specFile], { detached: true, stdio: 'ignore' })
    keeper.unref()
    return keeper.pid
  },
  alive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
  },
  stop(pid) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } },
  /** The commit a folder's checkout is at. */
  async head(cwd) {
    return (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 30_000 })).stdout.trim()
  },
  /** true when `commit` is in `branch` of the repo, false when it is not, null when git cannot say. */
  async inMain(repo, commit, branch) {
    try {
      await exec('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, branch], { timeout: 30_000 })
      return true
    } catch (err) {
      return err?.code === 1 ? false : null
    }
  },
}

// ── saving a track ────────────────────────────────────────────────────────────────

const words = (value, most = 4000) => (value === null || value === undefined ? '' : String(value).slice(0, most))
const names = (list, what) => {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new Refused(400, `${what} is a list of names`)
  for (const name of list) if (!NAME.test(String(name))) throw new Refused(400, `${what}: "${String(name).slice(0, 40)}" is not a name (small letters, numbers, - and _)`)
  return [...new Set(list.map(String))]
}

/**
 * A track as it is saved, or refused with the reason in plain words. The rules (docs/tracks.md):
 * steps are named once; every line joins two steps; a step has at most one way on for a pass and one
 * for a fail; every step that can fail has a fail line; a back-line has rounds and a `then` that is a
 * gate or a ruling step; every need comes from the request or from an earlier step; every step can be
 * reached; a track step names another saved track.
 */
export function checkTrack(body = {}, { trackKeys = [], selfKey = '' } = {}) {
  if (!Array.isArray(body.steps) || !body.steps.length) throw new Refused(400, 'A track needs at least one step')
  if (body.steps.length > MOST_STEPS) throw new Refused(400, `A track has at most ${MOST_STEPS} steps`)
  const inputs = names(body.inputs, 'The track\'s inputs')
  // Values a studio fills in once for the track (which bot builds, which checks): a request may say otherwise.
  const defaults = {}
  if (body.defaults !== undefined && (typeof body.defaults !== 'object' || Array.isArray(body.defaults) || body.defaults === null)) throw new Refused(400, 'A track\'s defaults are names and their values')
  for (const [name, value] of Object.entries(body.defaults || {})) {
    if (!NAME.test(name)) throw new Refused(400, `Default "${String(name).slice(0, 40)}" is not a name`)
    if (!inputs.includes(name)) throw new Refused(400, `Default "${name}" is not one of the track's inputs`)
    defaults[name] = words(value, 4000)
  }
  const steps = body.steps.map((raw, index) => {
    const step = raw && typeof raw === 'object' ? raw : {}
    const id = String(step.id || '')
    if (!NAME.test(id)) throw new Refused(400, `Step ${index + 1} needs an id: small letters, numbers, - and _`)
    if (!STEP_KINDS.includes(step.kind)) throw new Refused(400, `Step "${id}" is one of: ${STEP_KINDS.join(', ')}`)
    const out = { id, kind: step.kind, title: words(step.title, 200) || id, needs: names(step.needs, `Step "${id}" needs`), leaves: names(step.leaves, `Step "${id}" leaves`) }
    if (step.kind === 'bot') {
      if (!String(step.bot || '').trim()) throw new Refused(400, `Step "${id}" is a bot step: say which bot`)
      Object.assign(out, { bot: words(step.bot, 200).trim(), words: words(step.words, 40_000), ruling: Boolean(step.ruling) })
      if (step.model) out.model = words(step.model, 120)
      if (step.timeoutSec) out.timeoutSec = Math.max(60, Math.min(24 * 3600, Number(step.timeoutSec) || 0))
    }
    if (step.kind === 'script') {
      if (!String(step.command || '').trim()) throw new Refused(400, `Step "${id}" is a script step: give its command`)
      Object.assign(out, { command: words(step.command, 4000), timeoutSec: Math.max(5, Math.min(24 * 3600, Number(step.timeoutSec) || 1800)) })
    }
    if (step.kind === 'gate') out.words = words(step.words, 4000)
    if (step.kind === 'track') {
      const key = String(step.track || '')
      if (!key) throw new Refused(400, `Step "${id}" runs another track: say which`)
      if (key === selfKey) throw new Refused(400, `Step "${id}" cannot run the track it is in`)
      if (!trackKeys.includes(key)) throw new Refused(400, `Step "${id}" runs track "${key}", which is not saved here`)
      out.track = key
    }
    return out
  })
  const index = new Map()
  steps.forEach((s, n) => {
    if (index.has(s.id)) throw new Refused(400, `Two steps are called "${s.id}"`)
    index.set(s.id, n)
  })
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((raw) => {
    const line = raw && typeof raw === 'object' ? raw : {}
    const out = { from: String(line.from || ''), to: String(line.to || ''), on: line.on || 'pass' }
    if (!index.has(out.from) || !index.has(out.to)) throw new Refused(400, `A line joins steps of this track: "${out.from}" to "${out.to}" does not`)
    if (!LINE_ON.includes(out.on)) throw new Refused(400, `A line is taken on ${LINE_ON.join(', ')}`)
    // A fail line to an earlier step that redoes work is a back-line: it has rounds and a "then". One to an
    // earlier gate or ruling step needs neither, since the owner or the ruling bounds it.
    const target = steps[index.get(out.to)]
    const decides = target.kind === 'gate' || (target.kind === 'bot' && target.ruling)
    const back = out.on !== 'pass' && index.get(out.to) <= index.get(out.from) && !decides
    if (back) {
      const rounds = Number(line.rounds)
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > MOST_ROUNDS) throw new Refused(400, `The line back from "${out.from}" to "${out.to}" needs its rounds: 1 to ${MOST_ROUNDS}`)
      if (!index.has(String(line.then || ''))) throw new Refused(400, `The line back from "${out.from}" to "${out.to}" needs a "then": the step taken when its rounds are used`)
      const then = steps[index.get(String(line.then))]
      if (!(then.kind === 'gate' || (then.kind === 'bot' && then.ruling))) throw new Refused(400, `When the rounds back to "${out.to}" are used, the work goes to a gate or a ruling step, not to "${then.id}"`)
      Object.assign(out, { rounds, then: then.id })
    } else if (out.on !== 'fail' && index.get(out.to) <= index.get(out.from)) {
      throw new Refused(400, `A pass goes forward: "${out.from}" to "${out.to}" goes back`)
    }
    return out
  })
  for (const s of steps) {
    const on = (kind) => lines.filter((l) => l.from === s.id && (l.on === kind || l.on === 'always'))
    if (on('pass').length > 1) throw new Refused(400, `Step "${s.id}" has two ways on for a pass: one step runs at a time`)
    if (on('fail').length > 1) throw new Refused(400, `Step "${s.id}" has two ways on for a fail`)
    // A gate's "no" goes where the owner sends it; every other step that fails must have somewhere to go.
    if (s.kind !== 'gate' && !on('fail').length) throw new Refused(400, `Step "${s.id}" can fail and has nothing after a fail: give it a fail line (back to a step, to a gate or to a ruling step)`)
  }
  // Every need is there by the time its step starts: from the request, or left by an earlier step.
  steps.forEach((s, n) => {
    const before = new Set([...GIVEN, ...inputs, ...HANDED, ...steps.slice(0, n).flatMap((e) => e.leaves)])
    for (const need of s.needs) if (!before.has(need)) throw new Refused(400, `Step "${s.id}" needs "${need}", which no earlier step leaves and the request does not give`)
    // A bot named as $name is the bot the request (or the track's default) names under that input.
    if (s.kind === 'bot' && s.bot.startsWith('$') && !inputs.includes(s.bot.slice(1))) throw new Refused(400, `Step "${s.id}" takes its bot from "${s.bot.slice(1)}", which is not one of the track's inputs`)
  })
  // Every step can be reached from the first.
  const reached = new Set([steps[0].id])
  for (let grew = true; grew;) {
    grew = false
    for (const l of lines) {
      for (const to of [l.to, l.then].filter(Boolean)) if (reached.has(l.from) && !reached.has(to)) { reached.add(to); grew = true }
    }
  }
  const lost = steps.filter((s) => !reached.has(s.id)).map((s) => s.id)
  if (lost.length) throw new Refused(400, `No line reaches ${lost.map((id) => `"${id}"`).join(', ')}`)
  const delivers = body.delivers === 'nothing' ? 'nothing' : 'change'
  const main = /^[\w][\w./-]{0,99}$/.test(String(body.main || '')) ? String(body.main) : 'main'
  return { title: words(body.title, 200), description: words(body.description, 4000), inputs, defaults, delivers, main, steps, lines }
}

const sameShape = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const trackOf = (store, companyId, ref) => store.object('SELECT raw FROM tracks WHERE company_id = ? AND (id = ? OR key = ?)', companyId, ref, ref)
const versionOf = (store, trackId, version) => store.object('SELECT raw FROM track_versions WHERE track_id = ? AND version = ?', trackId, version)

/**
 * Save a track under its key: a new track, or a new version of the one with that key when its steps
 * or lines changed. The owner or a crew script saves tracks; a bot does not.
 */
export function saveTrack(store, companyId, body = {}, { now = Date.now(), actor, builtIn = false } = {}) {
  if (!builtIn) ownerOrScript(actor, 'saves a track')
  if (!store.row('SELECT id FROM company WHERE id = ?', companyId)) throw new Refused(404, 'Company not found')
  const key = String(body.key || '')
  if (!NAME.test(key)) throw new Refused(400, 'A track needs a key: small letters, numbers, - and _')
  const trackKeys = store.rows('SELECT key FROM tracks WHERE company_id = ? AND status = ?', companyId, 'active').map((r) => r.key)
  const shape = checkTrack(body, { trackKeys, selfKey: key })
  const before = trackOf(store, companyId, key)
  if (before) {
    const latest = versionOf(store, before.id, before.version)
    const { id, trackId, version, createdAt, ...kept } = latest || {}
    if (latest && sameShape(kept, shape) && before.status === 'active') return { ...before, unchanged: true }
  }
  const version = (before?.version || 0) + 1
  const track = { id: before?.id || randomUUID(), companyId, key, title: shape.title || key, description: shape.description, status: 'active', version, builtIn: before?.builtIn || builtIn, createdAt: before?.createdAt || iso(now), updatedAt: iso(now) }
  store.tx(() => {
    store.put('tracks', track)
    store.put('track_versions', { id: randomUUID(), trackId: track.id, version, ...shape, createdAt: iso(now) })
    note(store, 'track.saved', { type: 'track', id: track.id }, actor || ENGINE, { key, version }, now)
  })
  return track
}

/**
 * The built-in sample: a script step and an owner gate, so a new yard shows a whole trip without any
 * model key. The script counts what is in the project's folder (or the trip's own) and leaves a line
 * of report; the owner approves it at the gate.
 */
export const SAMPLE_TRACK = {
  key: 'sample-check',
  title: 'Sample: count and approve',
  description: 'A script counts what is in the folder, then you approve the count. No bot and no key needed.',
  delivers: 'nothing',
  steps: [
    {
      id: 'count', kind: 'script', title: 'Count the files', leaves: ['report'], timeoutSec: 60,
      command: 'node -e "const fs=require(\'fs\');const n=fs.readdirSync(\'.\').length;fs.writeFileSync(process.env.BOTYARD_STEP_OUT,JSON.stringify({verdict:\'pass\',leaves:{report:\'This folder holds \'+n+(n===1?\' file or folder.\':\' files and folders.\')},numbers:{entries:n}}))"',
    },
    { id: 'approve', kind: 'gate', title: 'You look at the count', words: 'Approve the count, or send it back with a note.' },
  ],
  lines: [
    { from: 'count', to: 'approve', on: 'always' },
  ],
}

/**
 * The crew's way, built in: brief, build, tests, a check by another bot, back to the builder with the
 * findings when a check fails, a ruling when the rounds are used, the owner when the ruling says no, and
 * the landing in main. The studio says which bots by the track's defaults (`builder`, `checker`, `lead`)
 * or each request does; the request's words are the brief. Saved again with other defaults, sections or
 * rounds, it is the studio's own.
 */
export const BUILD_TRACK = {
  key: 'build-check-land',
  title: 'Build, check, land',
  description: 'A bot builds, the tests run, another bot checks; a failed check goes back to the builder with its findings; the work is finished when it is in main.',
  inputs: ['builder', 'checker', 'lead'],
  steps: [
    { id: 'brief', kind: 'script', title: 'Brief check', command: 'node "$BOTYARD_TRACK_TOOLS/brief.mjs"', leaves: ['brief'], timeoutSec: 60 },
    { id: 'write-brief', kind: 'bot', bot: '$lead', title: 'Write the brief', needs: ['words'], leaves: ['brief'], words: 'Turn this request into a brief the builder can work from, with every section the brief check named in its findings. Save it as the document `brief`.' },
    { id: 'build', kind: 'bot', bot: '$builder', title: 'Build', needs: ['brief'], leaves: ['commit', 'report'], words: 'Build what the brief asks, commit it on this job\'s branch, and end your report with COMMIT: <sha> and OUTCOME: MET or NOT MET.' },
    { id: 'tests', kind: 'script', title: 'Tests', needs: ['commit'], command: 'sh -c "${BOTYARD_IN_TEST_COMMAND:-echo No test command is set for this project.}"', timeoutSec: 1800 },
    { id: 'check', kind: 'bot', bot: '$checker', title: 'Check', needs: ['brief', 'commit'], leaves: ['verdict'], words: 'Check the build against the brief: run what proves it, read the change. End with VERDICT: PASS or VERDICT: FAIL and, on a fail, what must change.' },
    { id: 'rule', kind: 'bot', bot: '$lead', title: 'Ruling', ruling: true, needs: ['brief'], leaves: ['verdict'], words: 'The rounds back to the builder are used. Read the findings and the work, and rule: VERDICT: PASS lands it as it is, VERDICT: FAIL hands it to the owner with what you would do.' },
    { id: 'owner', kind: 'gate', title: 'The owner decides', words: 'The crew could not finish this on its own. Approve to land it as it is, or send it back to a step with a note.' },
    { id: 'land', kind: 'script', title: 'Land in main', needs: ['commit'], leaves: ['commit'], command: 'node "$BOTYARD_TRACK_TOOLS/land.mjs"', timeoutSec: 3600 },
  ],
  lines: [
    { from: 'brief', to: 'build', on: 'pass' }, { from: 'brief', to: 'write-brief', on: 'fail' },
    { from: 'write-brief', to: 'build', on: 'pass' }, { from: 'write-brief', to: 'owner', on: 'fail' },
    { from: 'build', to: 'tests', on: 'pass' }, { from: 'build', to: 'build', on: 'fail', rounds: 1, then: 'rule' },
    { from: 'tests', to: 'check', on: 'pass' }, { from: 'tests', to: 'build', on: 'fail', rounds: 2, then: 'rule' },
    { from: 'check', to: 'land', on: 'pass' }, { from: 'check', to: 'build', on: 'fail', rounds: 2, then: 'rule' },
    { from: 'rule', to: 'land', on: 'pass' }, { from: 'rule', to: 'owner', on: 'fail' },
    { from: 'owner', to: 'land', on: 'pass' },
    { from: 'land', to: 'build', on: 'fail', rounds: 1, then: 'rule' },
  ],
}

const BUILT_IN = [SAMPLE_TRACK, BUILD_TRACK]
const seeded = new WeakSet()
/** The built-in tracks, saved once in every studio that does not have them yet. */
export function ensureBuiltIns(store, { now = Date.now() } = {}) {
  if (seeded.has(store)) return
  for (const company of store.rows('SELECT id FROM company')) {
    for (const track of BUILT_IN) if (!trackOf(store, company.id, track.key)) saveTrack(store, company.id, track, { now, builtIn: true })
  }
  seeded.add(store)
}

// ── requests and trips ────────────────────────────────────────────────────────────

const requestOr404 = (store, id) => {
  const found = store.object('SELECT raw FROM requests WHERE id = ?', id)
  if (!found) throw new Refused(404, 'Request not found')
  return found
}
const tripOr404 = (store, id) => {
  const found = store.object('SELECT raw FROM trips WHERE id = ?', id)
  if (!found) throw new Refused(404, 'Trip not found')
  return found
}
const putTrip = (store, trip, now) => store.put('trips', { ...trip, updatedAt: iso(now) })
const putRequest = (store, request, now) => store.put('requests', { ...request, updatedAt: iso(now) })
const putRow = (store, row, now) => store.put('trip_steps', { ...row, updatedAt: iso(now) })
const rowsOf = (store, tripId) => store.objects('SELECT raw FROM trip_steps WHERE trip_id = ? ORDER BY created_at, try_number', tripId)

function makeTrip(store, request, track, version, { parentTripId = null, parentStepRowId = null, inputs = {}, now }) {
  const trip = {
    id: randomUUID(), requestId: request.id, trackId: track.id, trackKey: track.key, version: version.version, status: 'running',
    current: version.steps[0].id, rounds: {}, handoff: null, parentTripId, parentStepRowId, inputs, reason: '',
    createdAt: iso(now), updatedAt: iso(now), endedAt: null,
  }
  store.put('trips', trip)
  return trip
}

/**
 * Ask for work on a track. The request is a job of its own (made here unless `jobId` names one) and its
 * first trip starts on the engine's next turn. A bot may ask (the lead asks for most work); the track and
 * its rules are the owner's.
 */
export function startRequest(store, companyId, body = {}, { now = Date.now(), actor } = {}) {
  ensureBuiltIns(store, { now })
  const track = trackOf(store, companyId, String(body.track || ''))
  if (!track || track.status !== 'active') throw new Refused(400, 'Say which saved track this request runs on')
  const version = versionOf(store, track.id, track.version)
  const given = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {}
  const filled = { ...(version.defaults || {}), ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined && v !== null && v !== '')) }
  const missing = version.inputs.filter((name) => filled[name] === undefined || filled[name] === '')
  if (missing.length) throw new Refused(400, `This track needs ${missing.join(', ')} from the request`)
  let job = body.jobId ? store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', body.jobId, body.jobId) : null
  if (body.jobId && !job) throw new Refused(400, 'That job does not exist')
  if (job && store.row("SELECT id FROM requests WHERE job_id = ? AND status NOT IN ('done', 'stopped')", job.id)) throw new Refused(409, 'That job already has a request moving')
  const projectId = body.projectId || job?.projectId || null
  if (version.delivers === 'change' && !projectId && !given.repo) throw new Refused(400, 'This track delivers a change: say which project (or repo) it lands in')
  if (!job) job = createJob(store, companyId, { title: words(body.title, 500) || track.title, description: words(body.words, 40_000), projectId, status: 'in_progress' }, { now, actor })
  const request = {
    id: randomUUID(), companyId, projectId, jobId: job.id, jobCode: job.identifier, trackId: track.id, trackKey: track.key, version: version.version,
    title: job.title, words: job.description || '', inputs: Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, words(v, VALUE_CHARS)])),
    status: 'working', askedBy: actor?.agent ? { agent: actor.agent } : { user: actor?.user || 'local-board' }, createdAt: iso(now), updatedAt: iso(now), finishedAt: null,
  }
  store.tx(() => {
    store.put('requests', request)
    makeTrip(store, request, track, version, { inputs: { title: request.title, words: request.words, ...request.inputs }, now })
    note(store, 'request.started', { type: 'issue', id: job.id }, actor, { track: track.key }, now)
  })
  return request
}

/** Every value a trip holds now: what it was given, then each live step's leaves, newest last. */
export function valuesOf(store, trip) {
  const out = { ...(trip.inputs || {}) }
  for (const row of rowsOf(store, trip.id)) {
    if (row.status !== 'passed' && row.status !== 'failed') continue
    for (const [name, value] of Object.entries(row.snapshot?.leaves || {})) if (value !== undefined && value !== null && value !== '') out[name] = value
  }
  return out
}

const latestRow = (store, tripId, stepId) => store.objects("SELECT raw FROM trip_steps WHERE trip_id = ? AND step_id = ? AND status != 'stale' ORDER BY created_at DESC, try_number DESC LIMIT 1", tripId, stepId)[0] || null

function projectFolder(store, projectId) {
  if (!projectId) return ''
  const found = store.row('SELECT cwd FROM project_workspaces WHERE project_id = ? AND cwd IS NOT NULL ORDER BY is_primary DESC LIMIT 1', projectId)
  return found?.cwd || ''
}

function botOf(store, companyId, ref) {
  return store.objects("SELECT raw FROM agents WHERE company_id = ? AND status != 'terminated'", companyId)
    .find((a) => a.id === ref || String(a.name || '').toLowerCase() === String(ref).toLowerCase() || a.urlKey === ref) || null
}

/** What a bot step's job says: the step's own words, what it has, and what to leave. */
export function botJobText(step, inputs) {
  const parts = [step.words || step.title]
  const shown = step.needs.filter((n) => inputs[n] !== undefined)
  if (shown.length) parts.push('## What you have', ...shown.map((n) => `### ${n}\n\n${words(inputs[n], VALUE_CHARS)}`))
  if (inputs.findings) parts.push('## Findings from the last check: fix these', words(inputs.findings, VALUE_CHARS))
  if (inputs.base) parts.push('## The work you continue', `Start from commit ${words(inputs.base, 80)}.`)
  if (inputs.note) parts.push('## The owner\'s note', words(inputs.note, VALUE_CHARS))
  const leave = step.leaves.filter((n) => n !== 'verdict')
  const asks = []
  if (step.ruling || step.leaves.includes('verdict')) asks.push('a document `verdict` that starts with PASS or FAIL and then says why')
  for (const n of leave) asks.push(`a document \`${n}\``)
  parts.push('## When you are done', `${asks.length ? `Save on this job ${asks.join(', ')}. ` : ''}Then mark this job done. This job is one step of a track: the engine reads what you leave and moves the work on.`)
  return parts.join('\n\n')
}

/** PASS / FAIL in the words the crew uses, or null when the text says neither. */
export function verdictOf(text) {
  const t = String(text || '').trim()
  if (/^(fail|failed|not met|rejected|no go|no-go|not approved)\b/i.test(t)) return 'fail'
  if (/^(pass|passed|met|approved|go|ok|report only)\b/i.test(t)) return 'pass'
  return null
}

/** Cost of the given jobs' bot runs: dollars where the tool said them, and tokens. */
export function costOfJobs(store, jobIds) {
  const out = { usd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runs: 0 }
  for (const id of jobIds.filter(Boolean)) {
    for (const run of store.rows('SELECT usage_json FROM runs WHERE job_id = ?', id)) {
      let usage = {}
      try { usage = JSON.parse(run.usage_json || '{}') || {} } catch { /* none kept */ }
      out.usd += Number(usage.costUsd) || 0
      out.inputTokens += Number(usage.inputTokens) || 0
      out.cachedInputTokens += Number(usage.cachedInputTokens) || 0
      out.outputTokens += Number(usage.outputTokens) || 0
      out.runs += 1
    }
  }
  out.usd = Math.round(out.usd * 10_000) / 10_000
  return out
}

const addCost = (a, b) => ({ usd: Math.round(((a.usd || 0) + (b.usd || 0)) * 10_000) / 10_000, inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0), cachedInputTokens: (a.cachedInputTokens || 0) + (b.cachedInputTokens || 0), outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0), runs: (a.runs || 0) + (b.runs || 0) })
const ZERO = { usd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runs: 0 }

/** One try of a step, as it costs: its bot job's runs (read now, so a run booked late counts), or what its script said. */
export function costOfRow(store, row) {
  if (row.jobId) return costOfJobs(store, [row.jobId])
  if (row.childTripId) return costOfTrip(store, row.childTripId)
  return { ...ZERO, usd: Number(row.snapshot?.costUsd) || 0 }
}
export const costOfTrip = (store, tripId) => rowsOf(store, tripId).reduce((sum, row) => addCost(sum, costOfRow(store, row)), { ...ZERO })
/** What a request cost, across all its trips, steps, rounds and reruns. */
export function costOfRequest(store, requestId) {
  return store.rows('SELECT id FROM trips WHERE request_id = ? AND parent_trip_id IS NULL', requestId).reduce((sum, t) => addCost(sum, costOfTrip(store, t.id)), { ...ZERO })
}

// ── the turn ──────────────────────────────────────────────────────────────────────

function shellOf(command) {
  // A command that starts with `node` runs on the same Node as Botyard, which may not be on the PATH.
  const line = String(command).replace(/^node(?=\s)/, `"${process.execPath}"`)
  return process.platform === 'win32' ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] } : { command: '/bin/sh', args: ['-c', line] }
}

const envName = (name) => `BOTYARD_IN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/** Start one step's try. Returns the row as it is now. */
async function startStep(store, trip, request, version, step, row, values, { dataDir, io, now }) {
  const inputs = { ...values, ...(row.inputs || {}) }
  if (step.kind === 'bot') {
    const named = step.bot.startsWith('$') ? String(inputs[step.bot.slice(1)] || '') : step.bot
    const bot = named && botOf(store, request.companyId, named)
    if (!bot) return { stuck: `Step "${step.id}" asks for a bot called "${named || step.bot}", and there is none` }
    const job = createJob(store, request.companyId, {
      title: `${request.title} · ${step.title}${row.try > 1 ? ` (round ${row.try})` : ''}`.slice(0, 500), description: `${botJobText(step, inputs)}\n\n${TRACK_MARK} ${trip.id}/${step.id}/${row.try}`,
      projectId: request.projectId, parentId: request.jobId, assigneeAgentId: bot.id, status: 'todo',
      ...(step.model ? { assigneeAdapterOverrides: { model: step.model } } : {}),
      ...(/^[\w][\w./-]{0,199}$/.test(String(inputs.base || '')) ? { baseRef: String(inputs.base) } : {}),
    }, { now, actor: ENGINE })
    return { ...row, status: 'working', jobId: job.id, jobCode: job.identifier, botId: bot.id, startedAt: iso(now) }
  }
  if (step.kind === 'script') {
    const dir = path.join(dataDir, 'trips', trip.id, row.id)
    fs.mkdirSync(dir, { recursive: true })
    const cwd = [inputs.workdir, projectFolder(store, request.projectId)].find((d) => d && fs.existsSync(d)) || dir
    const env = {
      ...process.env, BOTYARD_STEP_OUT: path.join(dir, 'out.json'), BOTYARD_TRIP_ID: trip.id, BOTYARD_REQUEST_JOB: request.jobCode || request.jobId, BOTYARD_STEP_ID: step.id,
      BOTYARD_TRACK_TOOLS: TRACK_TOOLS, BOTYARD_PROJECT_FOLDER: projectFolder(store, request.projectId), BOTYARD_MAIN: version.main, BOTYARD_REQUEST_TITLE: request.title,
    }
    for (const [name, value] of Object.entries(inputs)) if (NAME.test(name) && typeof value !== 'object') env[envName(name)] = String(value).slice(0, VALUE_CHARS)
    const { command, args } = shellOf(step.command)
    const spec = { runId: row.id, command, args, cwd, env, promptFile: '', logFile: path.join(dir, 'log.ndjson'), resultFile: path.join(dir, 'result.json'), pidFile: path.join(dir, 'pid.json'), timeoutSec: step.timeoutSec, graceSec: 10 }
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec))
    io.startKeeper(path.join(dir, 'spec.json'))
    return { ...row, status: 'working', folder: dir, cwd, startedAt: iso(now) }
  }
  if (step.kind === 'gate') {
    // The owner sees what the gate needs, what the step before it left, and any findings handed on.
    const order = version.steps.map((s) => s.id)
    const before = order.indexOf(step.id) > 0 ? latestRow(store, trip.id, order[order.indexOf(step.id) - 1]) : null
    const named = [...new Set([...step.needs, ...Object.keys(before?.snapshot?.leaves || {}).filter((n) => !['workdir', 'branch'].includes(n)), ...(inputs.findings ? ['findings'] : [])])]
    const shown = named.filter((n) => inputs[n] !== undefined).map((n) => `${n}: ${words(inputs[n], 600)}`).join('\n')
    const card = createCard(store, request.jobId, {
      kind: 'request_confirmation', title: `${step.title}`.slice(0, 500), summary: [step.words, shown].filter(Boolean).join('\n\n').slice(0, 4000),
      continuationPolicy: 'none', idempotencyKey: `trip-step:${row.id}`, payload: { tripId: trip.id, stepId: step.id, rowId: row.id },
    }, { now, actor: ENGINE })
    return { ...row, status: 'working', cardId: card.id, startedAt: iso(now) }
  }
  // Another track: a trip of its own under this one, for the same request.
  const inner = store.object("SELECT raw FROM tracks WHERE company_id = ? AND key = ? AND status = 'active'", request.companyId, step.track)
  if (!inner) return { stuck: `Step "${step.id}" runs track "${step.track}", which is no longer saved` }
  const innerVersion = versionOf(store, inner.id, inner.version)
  const missing = innerVersion.inputs.filter((n) => inputs[n] === undefined)
  if (missing.length) return { stuck: `Step "${step.id}" runs "${step.track}", which needs ${missing.join(', ')}` }
  const child = makeTrip(store, request, inner, innerVersion, { parentTripId: trip.id, parentStepRowId: row.id, inputs, now })
  return { ...row, status: 'working', childTripId: child.id, startedAt: iso(now) }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function tailOf(logFile, stream, most = 1500) {
  let text = ''
  try {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!line) continue
      try { const entry = JSON.parse(line); if (entry.stream === stream) text += entry.chunk } catch { /* a cut line */ }
    }
  } catch { /* no log */ }
  return text.slice(-most).trim()
}

/**
 * What a bot left on its job for each name: a document with that key, or else a `NAME: value` line in
 * its last comment (the crew's reports end with `COMMIT: …`, `VERDICT: …`, `OUTCOME: MET`).
 */
export function botLeft(docs, lastComment = '') {
  const lines = new Map()
  for (const line of String(lastComment || '').split('\n')) {
    const found = /^\s*[*_`]*([A-Z][A-Z _-]{1,30}?)[*_`]*\s*:\s*(.+?)\s*$/.exec(line)
    if (found) lines.set(found[1].trim().toLowerCase().replace(/[ -]+/g, '_'), found[2].replace(/^[*_`]+\s*/, '').replace(/[*_`]+$/, '').trim())
  }
  return (name) => (docs.has(name) ? docs.get(name) : lines.get(name))
}

/** The outcome of a working step, or null while it is still going. */
async function pollStep(store, step, row, { io, now }) {
  if (step.kind === 'bot') {
    const job = store.object('SELECT raw FROM jobs WHERE id = ?', row.jobId)
    if (!job) return { verdict: 'fail', findings: 'The step\'s job is gone' }
    if (job.status === 'cancelled') return { verdict: 'fail', findings: `The step's job ${job.identifier} was cancelled` }
    if (job.status !== 'done') return null
    const docs = new Map(store.rows('SELECT jd.key AS key, d.body AS body FROM job_documents jd JOIN documents d ON d.id = jd.document_id WHERE jd.job_id = ?', job.id).map((d) => [d.key, d.body]))
    const last = store.objects('SELECT raw FROM comments WHERE job_id = ? AND author_agent_id = ? ORDER BY position DESC LIMIT 1', job.id, job.assigneeAgentId || '')[0]
    const left = botLeft(docs, last?.body)
    // The verdict: a PASS or FAIL it said, or else its report's OUTCOME (MET or NOT MET), or else a closed job passes
    // unless the step asks for a verdict.
    const said = left('verdict') || left('outcome')
    const verdict = said ? verdictOf(said) || 'fail' : step.ruling || step.leaves.includes('verdict') ? 'fail' : 'pass'
    const leaves = {}
    for (const name of step.leaves) { const value = left(name); if (value !== undefined && value !== '') leaves[name] = words(value, VALUE_CHARS) }
    if (said) leaves.verdict = words(said, VALUE_CHARS)
    if (last?.body && step.leaves.includes('report') && !leaves.report) leaves.report = words(last.body, VALUE_CHARS)
    const place = store.object('SELECT raw FROM workspaces WHERE id = ? OR job_id = ? ORDER BY updated_at DESC LIMIT 1', job.executionWorkspaceId || '', job.id)
    if (place?.cwd && !leaves.workdir) leaves.workdir = place.cwd
    if (place?.branchName && !leaves.branch) leaves.branch = place.branchName
    // A commit it made but did not name: the head of its own branch, when that moved past where it started.
    if (step.leaves.includes('commit') && !leaves.commit && place?.branchName && io.head) {
      const head = await io.head(place.cwd).catch(() => '')
      if (head && !(place.baseRef && head.startsWith(place.baseRef))) leaves.commit = head
    }
    const missing = verdict === 'pass' ? step.leaves.filter((n) => n !== 'verdict' && n !== 'report' && leaves[n] === undefined) : []
    if (missing.length) return { verdict: 'fail', leaves, findings: `The step's job ${job.identifier} closed but did not leave ${missing.join(', ')}` }
    return { verdict, leaves, findings: verdict === 'fail' ? words(docs.get('verdict') || last?.body || said || `The job ${job.identifier} closed without a verdict`, VALUE_CHARS) : '' }
  }
  if (step.kind === 'script') {
    const result = readJson(path.join(row.folder, 'result.json'))
    if (!result) {
      const pid = readJson(path.join(row.folder, 'pid.json'))?.keeper
      if (io.alive(pid) || now - Date.parse(row.startedAt) < LOST_AFTER_MS) return null
      return { verdict: 'fail', findings: 'The script\'s keeper stopped without leaving a result' }
    }
    const out = readJson(path.join(row.folder, 'out.json')) || {}
    const said = out.verdict ? verdictOf(out.verdict) : null
    const verdict = result.timedOut || result.exitCode !== 0 ? 'fail' : said || 'pass'
    const leaves = {}
    const given = out.leaves && typeof out.leaves === 'object' ? out.leaves : {}
    for (const name of step.leaves) {
      const value = given[name] ?? out[name]
      if (value !== undefined && value !== null) leaves[name] = typeof value === 'string' ? words(value, VALUE_CHARS) : value
    }
    const stdout = tailOf(path.join(row.folder, 'log.ndjson'), 'stdout')
    const stderr = tailOf(path.join(row.folder, 'log.ndjson'), 'stderr')
    const findings = verdict === 'fail' ? words(out.findings || [result.timedOut ? `Stopped at its time limit of ${step.timeoutSec} s.` : `Ended with code ${result.exitCode}.`, stderr, stdout].filter(Boolean).join('\n'), VALUE_CHARS) : ''
    return { verdict, leaves, findings, numbers: out.numbers && typeof out.numbers === 'object' ? out.numbers : {}, summary: words(out.summary || stdout, 2000), costUsd: Number(out.costUsd) || 0, exitCode: result.exitCode }
  }
  if (step.kind === 'gate') {
    const card = store.object('SELECT raw FROM cards WHERE id = ?', row.cardId)
    if (!card || card.status === 'pending') return null
    if (card.status === 'accepted') return { verdict: 'pass', leaves: {}, findings: '' }
    return { verdict: 'fail', leaves: {}, findings: card.result?.reason || 'The owner said no at the gate', gateNo: true }
  }
  const child = store.object('SELECT raw FROM trips WHERE id = ?', row.childTripId)
  if (!child) return { verdict: 'fail', findings: 'The inner trip is gone' }
  if (child.status === 'done') {
    const values = valuesOf(store, child)
    const leaves = {}
    for (const name of step.leaves) if (values[name] !== undefined) leaves[name] = values[name]
    return { verdict: 'pass', leaves, findings: '' }
  }
  if (child.status === 'stuck' || child.status === 'stopped') return { verdict: 'fail', findings: child.reason || `The inner track ${child.trackKey} stopped` }
  return null
}

/** Move a trip to a step: that step and every later one start fresh; what they left before is kept but no longer read. */
function goTo(store, trip, version, target, handoff, now) {
  const order = new Map(version.steps.map((s, n) => [s.id, n]))
  for (const row of rowsOf(store, trip.id)) {
    if (row.status !== 'stale' && order.get(row.stepId) >= order.get(target)) {
      // A job still working on a step that starts over is let go of.
      if (row.status === 'working' && row.jobId) {
        const job = store.object('SELECT raw FROM jobs WHERE id = ?', row.jobId)
        if (job && !['done', 'cancelled'].includes(job.status)) patchJob(store, job.id, { status: 'cancelled' }, { now, actor: ENGINE })
      }
      if (row.status === 'working' && row.cardId) {
        const card = store.object('SELECT raw FROM cards WHERE id = ?', row.cardId)
        if (card?.status === 'pending') store.put('cards', { ...card, status: 'cancelled', result: { outcome: 'withdrawn' }, resolvedAt: iso(now), updatedAt: iso(now) }, { position: store.row('SELECT position FROM cards WHERE id = ?', card.id).position })
      }
      if (row.status === 'working' && row.childTripId) {
        const child = store.object('SELECT raw FROM trips WHERE id = ?', row.childTripId)
        if (child && MOVING.includes(child.status)) putTrip(store, { ...child, status: 'stopped', reason: 'Its step started over', endedAt: iso(now) }, now)
      }
      putRow(store, { ...row, status: 'stale', staleAt: iso(now) }, now)
    }
  }
  return { ...trip, current: target, handoff: { step: target, ...handoff } }
}

/** Where a step's outcome sends the trip, and the trip after it. */
function route(store, trip, version, step, row, outcome, now) {
  const lines = version.lines.filter((l) => l.from === step.id)
  const line = lines.find((l) => l.on === outcome) || lines.find((l) => l.on === 'always')
  const order = version.steps.map((s) => s.id)
  if (!line) {
    if (outcome === 'pass') return { ...trip, ended: true }
    // A gate's "no" with no fail line: the work goes back to the step before the gate.
    if (step.kind === 'gate' && order.indexOf(step.id) > 0) return goTo(store, trip, version, order[order.indexOf(step.id) - 1], { findings: row.snapshot?.findings || '', note: row.snapshot?.findings || '' }, now)
    return { ...trip, status: 'stuck', reason: `Step "${step.id}" failed and has nothing after it` }
  }
  const findings = row.snapshot?.findings || ''
  const back = outcome === 'fail' && order.indexOf(line.to) <= order.indexOf(step.id) && line.rounds
  if (!back) return goTo(store, trip, version, line.to, outcome === 'fail' ? { findings } : {}, now)
  const key = `${line.from}>${line.to}`
  const taken = trip.rounds?.[key] || 0
  // The work the round continues: the commit the step being redone left last time.
  const before = latestRow(store, trip.id, line.to)?.snapshot?.leaves?.commit || ''
  if (taken < line.rounds) return goTo(store, { ...trip, rounds: { ...trip.rounds, [key]: taken + 1 } }, version, line.to, { findings, ...(before ? { base: before } : {}) }, now)
  return goTo(store, trip, version, line.then, { findings: `${findings}\n\n(${line.rounds} round${line.rounds === 1 ? '' : 's'} back to "${line.to}" used; this step decides.)`.trim() }, now)
}

/** The end of a trip: the request is finished, or waits for its change to be in main. */
async function endTrip(store, trip, version, { io, now }) {
  if (trip.parentTripId) return { ...trip, status: 'done', endedAt: iso(now) }
  const request = requestOr404(store, trip.requestId)
  if (version.delivers === 'nothing') return finish(store, trip, request, now)
  const values = valuesOf(store, trip)
  if (!values.commit) return { ...trip, status: 'stuck', reason: 'The track ended but no step left a commit: a request that delivers a change is finished only when its commit is in main' }
  return checkMain(store, { ...trip, status: 'not-in-main', commit: String(values.commit), repo: String(values.repo || projectFolder(store, request.projectId) || '') }, request, version, { io, now })
}

async function checkMain(store, trip, request, version, { io, now }) {
  if (!trip.repo) return { ...trip, status: 'stuck', reason: 'The project has no folder to look for its main branch in' }
  const there = await io.inMain(trip.repo, trip.commit, version.main)
  if (there === true) return finish(store, trip, request, now)
  if (request.status !== 'not-in-main') putRequest(store, { ...request, status: 'not-in-main' }, now)
  return { ...trip, status: 'not-in-main', checkedAt: iso(now), reason: there === false ? `Commit ${trip.commit.slice(0, 12)} is not in ${version.main} yet` : `git could not say whether ${trip.commit.slice(0, 12)} is in ${version.main}` }
}

function finish(store, trip, request, now) {
  putRequest(store, { ...request, status: 'done', finishedAt: iso(now) }, now)
  const job = store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId)
  if (job && !['done', 'cancelled'].includes(job.status)) patchJob(store, job.id, { status: 'done' }, { now, actor: ENGINE })
  return { ...trip, status: 'done', reason: '', endedAt: iso(now) }
}

/**
 * One move of one trip. Returns true when it moved and may move again at once (a step ended and the
 * next one can start), false when it waits.
 */
async function moveTrip(store, tripId, ctx) {
  const { now } = ctx
  let trip = tripOr404(store, tripId)
  const version = versionOf(store, trip.trackId, trip.version)
  if (trip.status === 'not-in-main') {
    // Looked at again once a minute: a landing script merges on its own time.
    if (trip.checkedAt && now - Date.parse(trip.checkedAt) < 60_000) return false
    putTrip(store, await checkMain(store, trip, requestOr404(store, trip.requestId), version, ctx), now)
    return false
  }
  if (trip.status !== 'running') return false
  const request = requestOr404(store, trip.requestId)
  const step = version.steps.find((s) => s.id === trip.current)
  let row = latestRow(store, trip.id, step.id)
  if (!row) {
    const tries = store.row('SELECT COUNT(*) AS n FROM trip_steps WHERE trip_id = ? AND step_id = ?', trip.id, step.id).n
    const handed = trip.handoff?.step === step.id ? trip.handoff : {}
    const inputs = {}
    for (const name of HANDED) if (handed[name]) inputs[name] = words(handed[name], VALUE_CHARS)
    row = { id: randomUUID(), tripId: trip.id, requestId: request.id, stepId: step.id, kind: step.kind, title: step.title, try: tries + 1, status: 'waiting', inputs, snapshot: null, createdAt: iso(now) }
    putRow(store, row, now)
    putTrip(store, { ...trip, handoff: null }, now)
    trip = tripOr404(store, trip.id)
  }
  if (row.status === 'waiting') {
    const values = valuesOf(store, trip)
    const missing = step.needs.filter((n) => values[n] === undefined && row.inputs?.[n] === undefined)
    if (missing.length) {
      putTrip(store, { ...trip, status: 'stuck', reason: `Step "${step.id}" needs ${missing.join(', ')}, and nothing left it` }, now)
      return false
    }
    const started = await startStep(store, trip, request, version, step, row, values, ctx)
    if (started.stuck) {
      putRow(store, { ...row, status: 'failed', snapshot: { verdict: 'fail', findings: started.stuck, leaves: {} }, finishedAt: iso(now) }, now)
      putTrip(store, { ...trip, status: 'stuck', reason: started.stuck }, now)
      return false
    }
    putRow(store, started, now)
    // Looked at again at once: a short script may already have ended.
    return true
  }
  if (row.status === 'working') {
    const result = await pollStep(store, step, row, ctx)
    if (!result) return false
    const snapshot = { verdict: result.verdict, leaves: result.leaves || {}, findings: result.findings || '', numbers: result.numbers || {}, summary: result.summary || '', costUsd: result.costUsd || 0, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) }
    row = { ...row, status: result.verdict === 'pass' ? 'passed' : 'failed', snapshot, finishedAt: iso(now) }
    putRow(store, row, now)
  }
  // The step has ended (now, or before a restart came between): take its line.
  let next = route(store, trip, version, step, row, row.status === 'passed' ? 'pass' : 'fail', now)
  if (next.ended) { delete next.ended; next = await endTrip(store, next, version, ctx) }
  putTrip(store, next, now)
  return next.status === 'running'
}

/**
 * The engine's turn for tracks: every moving trip is moved as far as it can go now. Inner trips are
 * moved before the trips that wait on them.
 */
export async function tickTracks(store, { dataDir, io = trackIo, now = Date.now() } = {}) {
  ensureBuiltIns(store, { now })
  const report = { moved: [], stuck: [] }
  const trips = store.rows(`SELECT id FROM trips WHERE status IN (${MOVING.map(() => '?').join(', ')}) ORDER BY parent_trip_id IS NULL, created_at`, ...MOVING)
  for (const { id } of trips) {
    try {
      for (let n = 0; n < 12; n++) if (!(await moveTrip(store, id, { dataDir, io, now }))) break
    } catch (err) {
      const trip = store.object('SELECT raw FROM trips WHERE id = ?', id)
      if (trip) putTrip(store, { ...trip, status: 'stuck', reason: `The engine could not move this trip: ${String(err?.message || err).slice(0, 300)}` }, now)
    }
    const after = store.object('SELECT raw FROM trips WHERE id = ?', id)
    report.moved.push({ id, status: after?.status, current: after?.current })
    if (after?.status === 'stuck') report.stuck.push({ id, reason: after.reason })
  }
  return report
}

// ── the owner's hands on a trip ──────────────────────────────────────────────────────

const OPEN_AGAIN = ['done', 'stuck', 'stopped', 'not-in-main']

export function pauseTrip(store, tripId, { now = Date.now(), actor } = {}) {
  ownerOrScript(actor, 'pauses a trip')
  const trip = tripOr404(store, tripId)
  if (trip.status !== 'running') throw new Refused(409, `This trip is ${trip.status}, not running`)
  putTrip(store, { ...trip, status: 'paused', pausedAt: iso(now) }, now)
  return tripOr404(store, tripId)
}

export function resumeTrip(store, tripId, { now = Date.now(), actor } = {}) {
  ownerOrScript(actor, 'resumes a trip')
  const trip = tripOr404(store, tripId)
  if (trip.status !== 'paused') throw new Refused(409, `This trip is ${trip.status}, not paused`)
  putTrip(store, { ...trip, status: 'running', pausedAt: null }, now)
  return tripOr404(store, tripId)
}

export function stopTrip(store, tripId, { now = Date.now(), actor, reason = '' } = {}) {
  ownerOnly(actor, 'stops a trip')
  const trip = tripOr404(store, tripId)
  if (['done', 'stopped'].includes(trip.status)) throw new Refused(409, `This trip is already ${trip.status}`)
  const version = versionOf(store, trip.trackId, trip.version)
  // Every step still working is let go of, as on a rerun from the first step, but nothing starts again.
  const after = goTo(store, trip, version, version.steps[0].id, {}, now)
  putTrip(store, { ...after, current: trip.current, handoff: null, status: 'stopped', reason: words(reason, 500) || 'Stopped by the owner', endedAt: iso(now) }, now)
  if (!trip.parentTripId) {
    const request = requestOr404(store, trip.requestId)
    putRequest(store, { ...request, status: 'stopped' }, now)
  }
  return tripOr404(store, tripId)
}

/**
 * Run a trip again from a step, keeping every snapshot before it: the step and those after it start
 * fresh, with the owner's note when there is one. A finished or stuck trip opens again.
 */
export function rerunTrip(store, tripId, body = {}, { now = Date.now(), actor } = {}) {
  ownerOrScript(actor, 'reruns a trip')
  const trip = tripOr404(store, tripId)
  const version = versionOf(store, trip.trackId, trip.version)
  const step = version.steps.find((s) => s.id === body.step)
  if (!step) throw new Refused(400, `Say which step to run again: ${version.steps.map((s) => s.id).join(', ')}`)
  const said = words(body.note, VALUE_CHARS)
  const reopened = OPEN_AGAIN.includes(trip.status) || trip.status === 'paused'
  const next = goTo(store, trip, version, step.id, said ? { note: said } : {}, now)
  putTrip(store, { ...next, status: 'running', reason: '', endedAt: null, pausedAt: null, reruns: (trip.reruns || 0) + 1 }, now)
  if (reopened && !trip.parentTripId) {
    const request = requestOr404(store, trip.requestId)
    if (request.status !== 'working') putRequest(store, { ...request, status: 'working', finishedAt: null }, now)
    const job = store.object('SELECT raw FROM jobs WHERE id = ?', request.jobId)
    if (job && ['done', 'cancelled'].includes(job.status)) patchJob(store, job.id, { status: 'in_progress' }, { now, actor: ENGINE })
  }
  return tripOr404(store, tripId)
}

/**
 * The owner at a gate: approve it; send the work back to an earlier step with a note; or add context
 * and run the step before the gate again. Only the owner answers a gate.
 */
export function answerGate(store, tripId, body = {}, { now = Date.now(), actor } = {}) {
  ownerOnly(actor, 'answers a gate')
  const trip = tripOr404(store, tripId)
  const version = versionOf(store, trip.trackId, trip.version)
  const step = version.steps.find((s) => s.id === trip.current)
  const row = step && latestRow(store, trip.id, step.id)
  if (!step || step.kind !== 'gate' || row?.status !== 'working') throw new Refused(409, 'This trip is not waiting at a gate')
  const request = requestOr404(store, trip.requestId)
  const order = version.steps.map((s) => s.id)
  const action = String(body.action || '')
  if (action === 'approve') {
    settleCard(store, request.jobId, row.cardId, 'accept', {}, { now, actor })
    return tripOr404(store, tripId)
  }
  if (action !== 'back' && action !== 'context') throw new Refused(400, 'At a gate: approve, back (to a step, with a note) or context (a note, and the step before the gate runs again)')
  const said = words(body.note, VALUE_CHARS).trim()
  if (!said) throw new Refused(400, 'Say what to change: a note goes with the work')
  const to = action === 'context' ? body.to || order[order.indexOf(step.id) - 1] : body.to
  if (!order.includes(to) || order.indexOf(to) >= order.indexOf(step.id)) throw new Refused(400, `Send the work back to a step before the gate: ${order.slice(0, order.indexOf(step.id)).join(', ') || 'there is none'}`)
  settleCard(store, request.jobId, row.cardId, 'reject', { reason: said }, { now, actor })
  putRow(store, { ...row, status: 'failed', snapshot: { verdict: 'fail', leaves: {}, findings: said, sentBackTo: to }, finishedAt: iso(now) }, now)
  const next = goTo(store, tripOr404(store, tripId), version, to, { note: said }, now)
  putTrip(store, { ...next, status: 'running' }, now)
  return tripOr404(store, tripId)
}

// ── reading ───────────────────────────────────────────────────────────────────────

const trackShown = (store, track, version = track.version) => ({ ...track, current: versionOf(store, track.id, version) })

export const listTracks = (store, companyId) => {
  ensureBuiltIns(store)
  return store.objects("SELECT raw FROM tracks WHERE company_id = ? AND status = 'active' ORDER BY key", companyId).map((t) => trackShown(store, t))
}

export function getTrack(store, ref, query = {}) {
  const track = store.object('SELECT raw FROM tracks WHERE id = ?', ref) || store.object('SELECT raw FROM tracks WHERE key = ?', ref)
  if (!track) throw new Refused(404, 'Track not found')
  const version = Number(query.version) || track.version
  if (!versionOf(store, track.id, version)) throw new Refused(404, 'That version of the track does not exist')
  return { ...trackShown(store, track, version), versions: store.rows('SELECT version, created_at AS createdAt FROM track_versions WHERE track_id = ? ORDER BY version', track.id) }
}

/** A trip as the run view draws it: each step with its newest try, earlier tries, and cost. */
export function tripView(store, tripId) {
  const trip = tripOr404(store, tripId)
  const version = versionOf(store, trip.trackId, trip.version)
  const rows = rowsOf(store, trip.id).map((row) => ({ ...row, cost: costOfRow(store, row) }))
  const steps = version.steps.map((step) => {
    const tries = rows.filter((r) => r.stepId === step.id)
    const live = tries.filter((r) => r.status !== 'stale').at(-1) || null
    return { ...step, state: live?.status || (trip.current === step.id && trip.status === 'running' ? 'waiting' : 'not-started'), latest: live, tries, cost: tries.reduce((sum, r) => addCost(sum, r.cost), { ...ZERO }) }
  })
  const children = store.rows('SELECT id FROM trips WHERE parent_trip_id = ?', trip.id).map((r) => r.id)
  return { ...trip, track: { id: trip.trackId, key: trip.trackKey, version: trip.version, title: version.title, delivers: version.delivers, main: version.main, lines: version.lines }, steps, cost: costOfTrip(store, trip.id), innerTrips: children }
}

const requestShown = (store, request) => {
  const trips = store.objects('SELECT raw FROM trips WHERE request_id = ? AND parent_trip_id IS NULL ORDER BY created_at', request.id)
  const trip = trips.at(-1) || null
  const version = trip ? versionOf(store, trip.trackId, trip.version) : null
  const step = version?.steps.find((s) => s.id === trip.current)
  return { ...request, cost: costOfRequest(store, request.id), trip: trip ? { id: trip.id, status: trip.status, current: trip.current, currentTitle: step?.title || '', currentKind: step?.kind || '', reason: trip.reason || '', rounds: trip.rounds || {} } : null }
}

export function listRequests(store, companyId, query = {}) {
  const where = ['company_id = ?']
  const params = [companyId]
  if (query.status) { where.push('status = ?'); params.push(String(query.status)) }
  if (query.projectId) { where.push('project_id = ?'); params.push(String(query.projectId)) }
  const most = Math.min(500, Math.max(1, Number(query.limit) || 100))
  return store.objects(`SELECT raw FROM requests WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${most}`, ...params).map((r) => requestShown(store, r))
}

export function getRequest(store, ref) {
  const request = store.object('SELECT raw FROM requests WHERE id = ?', ref)
    || store.object('SELECT r.raw AS raw FROM requests r JOIN jobs j ON j.id = r.job_id WHERE j.id = ? OR j.identifier = ? ORDER BY r.created_at DESC LIMIT 1', ref, ref)
  if (!request) throw new Refused(404, 'Request not found')
  const trips = store.rows('SELECT id FROM trips WHERE request_id = ? AND parent_trip_id IS NULL ORDER BY created_at', request.id).map((t) => tripView(store, t.id))
  return { ...requestShown(store, request), trips }
}

// ── the API ───────────────────────────────────────────────────────────────────────

const one = '([^/]+)'
const route_ = (method, pattern, act) => [method, new RegExp(`^${pattern}$`), act]

/** The paths that change tracks, requests and trips: (store, parts, body, ctx) → [status, answer]. */
export const TRACK_WRITES = [
  route_('POST', `/companies/${one}/tracks`, (s, p, b, c) => [201, saveTrack(s, p[0], b, c)]),
  route_('POST', `/companies/${one}/requests`, (s, p, b, c) => [201, startRequest(s, p[0], b, c)]),
  route_('POST', `/trips/${one}/pause`, (s, p, b, c) => [200, pauseTrip(s, p[0], c)]),
  route_('POST', `/trips/${one}/resume`, (s, p, b, c) => [200, resumeTrip(s, p[0], c)]),
  route_('POST', `/trips/${one}/stop`, (s, p, b, c) => [200, stopTrip(s, p[0], { ...c, reason: b.reason })]),
  route_('POST', `/trips/${one}/rerun`, (s, p, b, c) => [200, rerunTrip(s, p[0], b, c)]),
  route_('POST', `/trips/${one}/gate`, (s, p, b, c) => [200, answerGate(s, p[0], b, c)]),
]

const READS = [
  [`/companies/${one}/tracks`, (s, p) => listTracks(s, p[0])],
  [`/tracks/${one}`, (s, p, q) => getTrack(s, p[0], q)],
  [`/companies/${one}/requests`, (s, p, q) => listRequests(s, p[0], q)],
  [`/requests/${one}`, (s, p) => getRequest(s, p[0])],
  [`/trips/${one}`, (s, p) => tripView(s, p[0])],
].map(([pattern, act]) => [new RegExp(`^${pattern}$`), act])

/** The answer for a track path, or null when it is not one. */
export function readTracks(store, where, query = {}) {
  for (const [pattern, act] of READS) {
    const match = pattern.exec(where)
    if (match) return { status: 200, body: act(store, match.slice(1).map((part) => decodeURIComponent(part)), query) }
  }
  return null
}
