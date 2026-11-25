/**
 * The manager's view of the studio: who is doing what right now, where each piece of work stands
 * between "being built" and "pushed", what happened today, and what is wrong.
 *
 * Read-only, and no AI. It is worked out from the engine's own records (jobs, bots, runs), the logs
 * the crew's scripts keep in $BOTYARD_HOME/crew, and git in each project's folder. The crew names its
 * jobs in a fixed way ("Check LH-12: title", "Fix 2 of title", "title (v2)", "Ruling: ..."), and the
 * work lines are read from those names: one line per piece of work, however many rounds it took.
 *
 * The phone's Home and the 3D map both draw this one answer, so it stays small: the phone choked on
 * large answers before, and the map asks for it every few seconds.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from './changes.mjs'
import { crewFolder, modelLabel } from './models.mjs'
import { crewLooks, roleOf } from './looks.mjs'
import { copyGroups, foldKeys, runningCopy } from './copies.mjs'
import { readRested } from './crew.mjs'
import { pilesOf, startOfToday } from './piles.mjs'
import { EngineError, call, cancelJob, companyId, crewRecords, jobComments, orElse, plainTitle, refOf, stopJob, withRefs } from './engine.mjs'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const LATE_MS = HOUR_MS
const SHOWN_LINES = 24
const SHOWN_FEED = 40
const SHOWN_TITLE = 72
const LOG_TAIL = 60
const VERDICT_LOOKBACK = 8
const VERDICT_AGE_MS = 3 * DAY_MS
const GIT_TTL_MS = 60_000
// "Check LH-12: …" is a checker's; "Check LH-12 (Lead): …" names who rules on it after the check.
const CHECK = /^Check ([A-Z]+-\d+)( \([^)]{1,40}\))?:\s*/
const FIX = /^Fix (\d+) of /
const RULING = /^Ruling:\s*/
const VERSION = /\s*\(v(\d+)\)$/
const LOG_LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) (.*)$/
const MERGED = /^([A-Z]+-\d+) ([0-9a-f]{7,40}) into (\S+) (\S+): merged/
const STOPPED = /^([A-Z]+-\d+) stopped by ([^:]+): (.*)$/
const MODEL_ID = /\b[\w.-]+\/[\w./:-]+/g
const OPEN = new Set(['in_progress', 'todo', 'backlog', 'blocked', 'in_review'])
const WAITING = new Set(['todo', 'backlog'])
const WHERE = { claude_local: 'Claude', codex_local: 'Codex', gemini_local: 'Antigravity', opencode_local: 'free' }
const STEPS = ['build', 'check', 'ruling', 'merged', 'pushed']
const SETTLED = new Set(['pushed', 'kept', 'replaced', 'stopped'])
const NO_REPO = { unpushed: null, remote: false, merged: new Set(), pushed: new Set() }

const short = (text, max = SHOWN_TITLE) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const stamp = (value) => (value ? Date.parse(value) || 0 : 0)
const lastTouched = (issue) => stamp(issue.lastActivityAt || issue.updatedAt || issue.createdAt)
/** When a job last changed hands. The crew's scripts comment on old jobs, so a finished job's activity time is not it. */
const movedAt = (issue) => (OPEN.has(issue.status) ? lastTouched(issue) : stamp(issue.completedAt || issue.cancelledAt || issue.startedAt || issue.createdAt))
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const clock = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

function readJson(file, empty) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value === null || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(empty) ? empty : value
  } catch {
    return empty
  }
}

/** The last lines of one of the crew's logs, each with its time. The scripts write local time. */
function readLog(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').slice(-LOG_TAIL).map((line) => {
    const match = LOG_LINE.exec(line)
    if (!match) return null
    const [, y, mo, d, h, mi, rest] = match
    return { at: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime(), text: rest }
  }).filter(Boolean)
}

/**
 * Short lines a crew script leaves for the owner (crew/owner-notes.jsonl, {"at", "text"} per line): shown under "Also
 * going on" for two days, never as a card. For news the owner should see but not answer (a ruling that landed).
 */
const NOTE_DAYS = 2
function readOwnerNotes(file, now = Date.now()) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  return text.split('\n').slice(-200).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((n) => n && typeof n.text === 'string' && Date.parse(n.at) > now - NOTE_DAYS * 86_400_000)
    .slice(-6).map((n) => ({ at: Date.parse(n.at), text: n.text.replace(/[\u0000-\u001f]/g, ' ').slice(0, 240) }))
}

/** What the crew's scripts wrote down, read once per answer. Every file may be missing. */
export function readCrewFiles(folder = crewFolder()) {
  const at = (name) => path.join(folder, name)
  return {
    merges: readLog(at('merges.log')),
    stopped: readLog(at('sessions-stopped.log')),
    switches: readLog(at('fallback.log')),
    pace: readJson(at('pace.json'), {}),
    thinker: readJson(at('thinker.json'), {}),
    freeOut: readJson(at('free-out.json'), {}),
    freeOk: readJson(at('free-ok.json'), {}),
    notInMain: readJson(at('not-in-main.json'), {}),
    ownerNotes: readOwnerNotes(at('owner-notes.jsonl')),
    rested: readRested(folder),
  }
}

/** What a job is, from the way the crew names it. */
export function kindOf(title = '') {
  const check = CHECK.exec(title)
  if (check) return { kind: 'check', of: check[1], ruling: Boolean(check[2]) }
  if (RULING.test(title)) return { kind: 'ruling' }
  const fix = FIX.exec(title)
  return fix ? { kind: 'fix', round: Number(fix[1]) } : { kind: 'build' }
}

/** A title without its round and retry marks, so every round of one piece of work has the same name. */
export const workName = (title = '') => title.replace(FIX, '').replace(VERSION, '').trim()

/**
 * What a checker decided, from the newest comments on its check (newest first). The checker writes
 * "## OUTCOME: PASS", the crew's review guard reads "VERDICT: PASS", and the lead lists "BLOCKING"
 * findings; a check that says neither has no verdict, and the line says so instead of guessing.
 */
export function verdictOf(comments = []) {
  for (const comment of comments) {
    if (comment.authorType !== 'agent') continue
    const body = comment.body || ''
    const named = /(?:OUTCOME|VERDICT)\W{1,6}(PASS|FAIL|BLOCK|NOT MET|MET)/i.exec(body)
    if (named) return /^(PASS|MET)$/i.test(named[1]) ? 'pass' : 'blocking'
    if (/\bBLOCKING\b/.test(body)) return 'blocking'
    if (/\bPASS(ED)?\b/.test(body)) return 'pass'
  }
  return null
}

const stepOf = (state, extra = {}) => ({ state, ...extra })

/** One check on a piece of work, as a step: running, passed, found problems, or not asked for. */
function checkStep(check, verdicts, isLive = () => true) {
  if (!check) return stepOf('wait')
  // Marked in progress with no run going is waiting for a bot, not being worked on (25 Nov 2026: 47 jobs read "working" with 5 runs going).
  if (check.status === 'in_progress') return stepOf(isLive(check) ? 'now' : 'queued', { id: check.id, since: stamp(check.startedAt) || lastTouched(check) })
  if (WAITING.has(check.status)) return stepOf('queued', { id: check.id, since: stamp(check.createdAt) })
  if (check.status === 'blocked') return stepOf('failed', { id: check.id, why: 'the check is blocked' })
  if (check.status === 'cancelled') return stepOf('wait')
  const verdict = verdicts.get(check.id)
  return verdict === 'blocking' ? stepOf('failed', { id: check.id, why: 'found blocking problems' }) : stepOf('done', { id: check.id, unsure: !verdict })
}

/**
 * Every piece of work as one line: Build, Check (the checker), the lead, Merged, Pushed. A line follows the
 * newest round that was not cancelled, and counts the rounds before it.
 */
/** Dollars as a line says them. */
const usd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0')

/**
 * A request on a track as one work line: where its trip stands, who is on its step now (the line wears that bot's
 * colour, like any other), and what it cost so far, across every step, round and rerun. Its steps' own jobs are not
 * lines of their own. A script or a gate names nobody: the line says the step instead.
 */
export function requestLine(r, issue, projectNames, now, names = new Map()) {
  const trip = r.trip || {}
  const cost = Number(r.cost?.usd) || 0
  const step = trip.currentTitle || ''
  const said = step ? step.charAt(0).toLowerCase() + step.slice(1) : 'its next step'
  const working = !['done', 'not-in-main', 'stopped'].includes(r.status) && !['stopped', 'stuck', 'paused', 'not-in-main', 'done'].includes(trip.status)
  const who = working && trip.currentKind === 'bot' ? names.get(trip.currentBotId) || '' : ''
  const checks = trip.currentRuling || /check|test|review|rul/i.test(`${trip.current} ${step}`)
  // The rounds back to this step so far, over every back-line that leads to it (keyed "from>to").
  const fixes = Object.entries(trip.rounds || {}).filter(([key]) => key.endsWith(`>${trip.current}`)).reduce((a, [, n]) => a + (Number(n) || 0), 0)
  let stage = 'build'
  let pill = ''
  let note = ''
  if (r.status === 'done') { stage = 'merged'; note = 'In main' }
  else if (r.status === 'not-in-main' || trip.status === 'not-in-main') { stage = 'passed'; note = 'Done, not in main yet' }
  else if (r.status === 'stopped' || trip.status === 'stopped') { stage = 'stopped'; note = 'Stopped' }
  else if (trip.status === 'stuck') { stage = 'blocked'; note = `Stuck: ${trip.reason || 'see its trip'}` }
  else if (trip.status === 'paused') { stage = 'queued'; note = `Paused at ${said}` }
  else if (trip.currentKind === 'gate') { stage = 'queued'; pill = 'waits'; note = `Waiting for you: ${said}` }
  else if (trip.currentKind === 'bot' && !who) { stage = checks ? 'check' : 'build'; note = `Waiting for a bot to take ${said}, on its track` }
  else if (trip.currentRuling) { stage = 'ruling'; note = `${who} is ruling on it, on its track` }
  else if (checks && who) { stage = 'check'; note = `${who} is checking it, on its track` }
  else if (who && /build|fix|code/i.test(`${trip.current} ${step}`)) { stage = 'build'; note = `${who} is ${fixes ? `on fix ${fixes}` : 'building it'}, on its track` }
  else if (who) { stage = 'build'; note = `${who} is on ${said}, on its track` }
  else { stage = checks ? 'check' : 'build'; note = `${step || 'Starting'}, on its track` }
  const rounds = Object.values(trip.rounds || {}).reduce((a, b) => a + b, 0)
  const at = Date.parse(r.updatedAt) || now
  const state = (name) => ({ build: stage === 'build' ? 'now' : 'done', check: stage === 'check' ? 'now' : ['merged', 'passed'].includes(stage) ? 'done' : 'wait', ruling: 'skipped', merged: stage === 'merged' ? 'done' : 'wait', pushed: 'wait' })[name]
  return {
    id: issue?.id || r.jobId, ref: issue ? refOf(issue, projectNames) : r.jobCode, title: short(plainTitle(withRefs(r.title))), project: projectNames.get(r.projectId) || '', projectId: r.projectId || '',
    bot: who, stage, pill: pill || stage, note: `${note}${cost > 0 ? `, ${usd(cost)} so far` : ''}`, steps: STEPS.map(state), fixes: rounds, since: at, late: false,
    open: !['merged', 'stopped'].includes(stage), at, track: { tripId: trip.id || '', cost, costText: usd(cost), status: r.status },
  }
}

function workLines({ issues, names, roles = new Map(), projectNames, verdicts, mergedAt, repos, now, requests = [], liveJobs = null }) {
  // With the live runs known, "now" means a run is going on that job; without them (an older caller), the job's own word stands.
  const isLive = (issue) => !liveJobs || liveJobs.has(issue.id) || liveJobs.has(`bot:${issue.assigneeAgentId}`)
  const groups = new Map()
  const checks = new Map()
  // Work moved by a track is the request's one line; its steps' jobs are left out here.
  const onTrack = new Map(requests.map((r) => [r.jobId, r]))
  const byId = new Map(issues.map((i) => [i.id, i]))
  for (const issue of issues) {
    if (onTrack.has(issue.id) || onTrack.has(issue.parentId)) continue
    const what = kindOf(issue.title)
    if (what.kind === 'ruling') continue
    if (what.kind === 'check') {
      checks.set(what.of, [...(checks.get(what.of) || []), { ...issue, ruling: what.ruling || ['lead', 'ruler'].includes(roles.get(issue.assigneeAgentId)) }])
      continue
    }
    const key = `${issue.projectId || ''}|${workName(issue.title)}`
    groups.set(key, [...(groups.get(key) || []), issue])
  }
  const lines = []
  for (const rounds of groups.values()) {
    rounds.sort((a, b) => a.issueNumber - b.issueNumber)
    const kept = rounds.filter((r) => r.status !== 'cancelled')
    const work = kept[kept.length - 1] || rounds[rounds.length - 1]
    const mine = (checks.get(work.identifier) || []).sort((a, b) => a.issueNumber - b.issueNumber)
    const all = [...rounds, ...rounds.flatMap((r) => checks.get(r.identifier) || [])]
    const touched = Math.max(...all.map(movedAt), mergedAt.get(work.identifier) || 0)
    if (now - touched > DAY_MS && !all.some((i) => OPEN.has(i.status))) continue

    const latest = (ruling) => mine.filter((c) => c.ruling === ruling && c.status !== 'cancelled').pop()
    const build = work.status === 'in_progress' ? stepOf(isLive(work) ? 'now' : 'queued', { since: stamp(work.startedAt) || lastTouched(work) })
      : work.status === 'done' ? stepOf('done')
      : work.status === 'blocked' ? stepOf('failed', { why: 'blocked' })
      : work.status === 'cancelled' ? stepOf('failed', { why: 'stopped' })
      : stepOf('queued', { since: stamp(work.createdAt) })
    const built = build.state === 'done'
    const check = built ? checkStep(latest(false), verdicts, isLive) : stepOf('wait')
    const ruling = built ? checkStep(latest(true), verdicts, isLive) : stepOf('wait')
    const repo = repos.get(work.projectId) || NO_REPO
    const merged = built && (mergedAt.has(work.identifier) || repo.merged.has(work.identifier))
    const isPushed = merged && repo.pushed.has(work.identifier)
    // Work that failed its check is settled once the crew has started something newer in the project:
    // The lead names follow-up jobs freely, so a later job is the only sign there is.
    const failedAt = [check, ruling].filter((s) => s.state === 'failed').map((s) => movedAt(mine.find((c) => c.id === s.id)))[0]
    const followed = failedAt && issues.some((i) => i.projectId === work.projectId && kindOf(i.title).kind !== 'check' && stamp(i.createdAt) > failedAt)
    const steps = {
      build,
      check: check.state === 'wait' && (ruling.state !== 'wait' || merged) ? stepOf('skipped') : check,
      ruling: ruling.state === 'wait' && merged ? stepOf('skipped') : ruling,
      merged: merged ? stepOf('done') : stepOf('wait'),
      pushed: isPushed ? stepOf('done') : stepOf('wait'),
    }
    const at = STEPS.find((name) => steps[name].state === 'now') || STEPS.find((name) => steps[name].state === 'failed')
      || STEPS.find((name) => steps[name].state === 'queued')
    const state = at ? steps[at].state : null
    const who = { build: names.get(work.assigneeAgentId) || 'A bot', check: names.get(latest(false)?.assigneeAgentId) || 'A checker', ruling: names.get(latest(true)?.assigneeAgentId) || 'The lead' }
    const checked = [steps.check, steps.ruling].some((s) => s.state === 'done')
    const fixes = kept.length > 1 ? kept.length - 1 : 0
    let stage
    let note
    if (state === 'now') {
      stage = at
      note = at === 'build' ? `${who.build} is ${fixes ? `on fix ${fixes}` : 'building it'}` : `${who[at]} is checking it`
    } else if (state === 'failed' && at !== 'build' && (followed || merged)) {
      stage = 'replaced'
      note = `${who[at]} ${steps[at].why}; newer work took over`
    } else if (state === 'failed') {
      stage = at === 'build' ? (steps.build.why === 'stopped' ? 'stopped' : 'blocked') : 'fix'
      note = at === 'build' ? (steps.build.why === 'stopped' ? 'Stopped, and nothing replaced it' : `Blocked: ${who.build} cannot go on`)
        : `${who[at]} ${steps[at].why}; no fix has started`
    } else if (state === 'queued') {
      stage = 'queued'
      note = at === 'build' ? `Waiting for ${who.build} to start` : `Waiting for ${who[at]} to check it`
    } else if (steps.pushed.state === 'done') {
      stage = 'pushed'
      note = 'Merged and pushed'
    } else if (merged) {
      stage = repo.remote ? 'merged' : 'kept'
      note = repo.remote ? 'Merged on this machine, not pushed yet' : 'Merged; this project is not on GitHub'
    } else if (checked) {
      stage = 'passed'
      note = 'Passed its check, waiting to be merged'
    } else {
      stage = 'built'
      note = 'Built; no check was asked for'
    }
    const since = at ? steps[at].since || touched : touched
    const waitingOn = state === 'now' || state === 'queued'
    lines.push({
      id: work.id,
      ref: refOf(work, projectNames),
      title: short(plainTitle(withRefs(workName(work.title)))),
      project: projectNames.get(work.projectId) || '',
      projectId: work.projectId || '',
      bot: who.build,
      stage,
      // The pill: "Checking" while the lead checks, "Ruling" only when a bot whose role is ruler is on it.
      pill: stage === 'ruling' && roles.get(latest(true)?.assigneeAgentId) === 'ruler' ? 'ruled' : stage,
      note,
      steps: STEPS.map((name) => steps[name].state),
      fixes,
      since,
      late: waitingOn && now - since > LATE_MS,
      open: !SETTLED.has(stage),
      at: touched,
    })
  }
  for (const r of requests) {
    const at = Date.parse(r.updatedAt) || 0
    if (['done', 'stopped'].includes(r.status) && now - at > DAY_MS) continue
    lines.push(requestLine(r, byId.get(r.jobId), projectNames, now, names))
  }
  const rank = { build: 0, check: 0, ruling: 0, fix: 1, blocked: 1, queued: 2, passed: 3, built: 3, merged: 4, kept: 6, replaced: 6, stopped: 6, pushed: 6 }
  return lines.sort((a, b) => rank[a.stage] - rank[b.stage] || b.at - a.at).slice(0, SHOWN_LINES)
}

/** What each bot is doing this minute. A job marked running with no live run is said to be waiting. */
function workingNow({ issues, names, projectNames, agents, liveAgents, liveJobs = new Set(), unnamed = new Set(), fold = copyGroups([]), now }) {
  const models = new Map(agents.map((a) => [a.id, a.adapterConfig?.model || '']))
  // A run going on a job puts its bot in that job's bay, even before the job is marked in progress.
  return issues.filter((i) => (i.status === 'in_progress' || (liveJobs.has(i.id) && i.status !== 'done' && i.status !== 'cancelled')) && i.assigneeAgentId).map((issue) => {
    const what = kindOf(issue.title)
    const since = stamp(issue.startedAt) || lastTouched(issue)
    return {
      id: issue.id,
      ref: refOf(issue, projectNames),
      title: short(withRefs(what.kind === 'check' ? issue.title.replace(CHECK, '') : workName(issue.title).replace(RULING, ''))),
      // A copy's job is its bot's: the card shows the bot, with the AI the copy runs on.
      botId: fold.idOf(issue.assigneeAgentId),
      copyId: issue.assigneeAgentId,
      bot: names.get(issue.assigneeAgentId) || 'A bot',
      project: projectNames.get(issue.projectId) || '',
      projectId: issue.projectId || '',
      model: modelLabel(models.get(issue.assigneeAgentId)),
      stage: what.kind === 'check' ? `Checking ${withRefs(what.of)}` : what.kind === 'ruling' ? 'Ruling' : what.kind === 'fix' ? `Fix ${what.round}` : 'Building',
      minutes: Math.max(0, Math.round((now - since) / 60_000)),
      live: liveAgents.has(issue.assigneeAgentId),
      // A run is going on this very job; a job marked in progress whose run has ended is not being worked on.
      running: liveJobs.has(issue.id) || unnamed.has(issue.assigneeAgentId),
    }
  }).sort((a, b) => a.minutes - b.minutes)
}

/** Why a paused bot is paused, in the owner's words. The token guard pauses the Claude bots when the week runs out. */
function pauseWhy(agent, files, now) {
  if (agent.status !== 'paused') return ''
  // health.py rests a bot whose engine ran out (STANDARDS.md rule 3), and wakes it at the reset.
  const rest = files.rested?.[agent.id]
  if (rest && rest.until > now) return rest.text
  const { pace } = files
  if (agent.adapterType === 'claude_local' && pace.week >= (pace.cap ?? 1) * 0.9 && pace.resets * 1000 > now) {
    return `Claude's week is ${Math.round(pace.week * 100)}% used; back ${clock(pace.resets * 1000)}`
  }
  return agent.pauseReason === 'manual' ? 'Paused by hand' : agent.pauseReason ? `Paused: ${agent.pauseReason}` : 'Paused'
}

/** Every bot, with the job it is on or the last one it touched, and the project that puts it in. */
/**
 * The crew in fixed places by the chain of command (the owner, 12 November 2026: "let the bots have
 * specific position with hierarchy instead of a line that changes based on who is working"). Who is
 * working shows on the bot, never by moving it. Read by role: the lead, the judges, the builders, the checkers; within a tier,
 * under whoever a bot reports to, then by name.
 */
const TIERS = [['lead', 'Lead'], ['ruler', 'Judges'], ['reviewer', 'Judges'], ['builder', 'Builders'], ['checker', 'Checkers'], ['researcher', 'Research'], ['general', 'Crew']]
const RANK = new Map(TIERS.map(([role, tier], i) => [role, { i, tier }]))

/** The bots in their fixed order, each with its tier; the order never depends on who is working. */
export function inHierarchy(rows, agents = []) {
  const reportsTo = new Map(agents.map((a) => [a.id, a.reportsTo || null]))
  const depth = (id, seen = new Set()) => {
    const boss = reportsTo.get(id)
    return boss && !seen.has(boss) ? 1 + depth(boss, seen.add(id)) : 0
  }
  return rows
    .map((row) => ({ row, rank: RANK.get(row.role) || RANK.get('general') }))
    .sort((a, b) => a.rank.i - b.rank.i || depth(a.row.id) - depth(b.row.id) || a.row.name.localeCompare(b.row.name))
    .map(({ row, rank }) => ({ ...row, tier: rank.tier }))
}

/** How far back a bot's jobs count toward the projects it is working in: a mini of it stands in each. */
export const ALSO_IN_MS = 6 * 60 * 60 * 1000

/**
 * The other projects a bot is working in: those of its jobs running now or touched in the last six
 * hours, other than the one its current job puts it in. Names, in the order of their latest touch.
 */
export function alsoIn({ issues, botId, projectNames, home, now }) {
  const latest = new Map()
  for (const i of issues) {
    if (i.assigneeAgentId !== botId || !i.projectId || i.projectId === home) continue
    const at = lastTouched(i)
    if (i.status !== 'in_progress' && now - at > ALSO_IN_MS) continue
    latest.set(i.projectId, Math.max(latest.get(i.projectId) || 0, at))
  }
  return [...latest].sort((a, b) => b[1] - a[1]).map(([id]) => projectNames.get(id)).filter(Boolean)
}

function botRows({ agents, issues, projectNames, liveAgents, working, files, fold = copyGroups([]), now }) {
  const newest = [...issues].sort((a, b) => lastTouched(b) - lastTouched(a))
  const looks = crewLooks(agents)
  return inHierarchy(agents.map((agent) => {
    // One card per bot: its copies on other AIs count as it (their jobs are already put under its id).
    const mine = working.filter((w) => w.botId === agent.id)
    const job = mine[0] || null
    const last = job ? null : newest.find((i) => i.assigneeAgentId === agent.id)
    const today = issues.filter((i) => i.assigneeAgentId === agent.id && i.status === 'done' && now - stamp(i.completedAt) < DAY_MS).length
    const family = fold.family(agent)
    const on = runningCopy(agent, fold, { liveIds: liveAgents, heldIds: new Set(mine.map((w) => w.copyId)) })
    const copies = family.length > 1 ? family.map((a) => ({ id: a.id, name: a.name, model: modelLabel(a.adapterConfig?.model), where: WHERE[a.adapterType] || 'Other', running: a.id === on.id })) : null
    return {
      id: agent.id,
      name: agent.name,
      title: agent.title || '',
      ...looks.get(agent.id),
      status: family.some((a) => liveAgents.has(a.id)) || job ? 'running' : agent.status,
      model: modelLabel(on.adapterConfig?.model),
      where: WHERE[on.adapterType] || 'Other',
      // Set only for a bot with copies: the AI the running copy is on, for the tag on its card.
      ...(copies ? { copies, on: WHERE[on.adapterType] || 'Other' } : {}),
      why: pauseWhy(agent, files, now),
      ...(agent.status === 'paused' && files.rested?.[agent.id]?.until > now ? { resting: true } : {}),
      job: job && { id: job.id, ref: job.ref, title: job.title, stage: job.stage, minutes: job.minutes },
      // Every job it holds now, for "checking 3".
      jobs: mine.map((w) => ({ id: w.id, ref: w.ref, title: w.title, stage: w.stage, minutes: w.minutes })),
      last: last ? { id: last.id, ref: refOf(last, projectNames), title: short(withRefs(last.title)), at: lastTouched(last) } : null,
      projectId: job?.projectId || last?.projectId || '',
      alsoIn: alsoIn({ issues, botId: agent.id, projectNames, home: job?.projectId || '', now }),
      doneToday: today,
    }
  }), agents)
}

/** The last day as a list of things that happened, newest first. */
function dayFeed({ issues, names, projectNames, byRef, files, verdicts, now }) {
  const since = now - DAY_MS
  const events = []
  const named = (ref) => (byRef.has(ref) ? refOf(byRef.get(ref), projectNames) : ref)
  for (const issue of issues) {
    const what = kindOf(issue.title)
    const bot = names.get(issue.assigneeAgentId) || 'A bot'
    const ref = refOf(issue, projectNames)
    const title = short(withRefs(workName(issue.title)), 60)
    const done = stamp(issue.completedAt)
    if (issue.status === 'done' && done >= since) {
      if (what.kind === 'check') {
        const verdict = verdicts.get(issue.id)
        const said = verdict === 'pass' ? 'passed' : verdict === 'blocking' ? 'found blocking problems in' : 'checked'
        events.push({ at: done, kind: verdict === 'blocking' ? 'blocking' : 'check', id: issue.id, text: `${bot} ${said} ${named(what.of)}` })
      } else if (what.kind === 'ruling') {
        events.push({ at: done, kind: 'ruling', id: issue.id, text: `${bot} ruled: ${short(withRefs(issue.title.replace(RULING, '')), 60)}` })
      } else {
        events.push({ at: done, kind: 'done', id: issue.id, text: `${bot} finished ${ref} ${title}` })
      }
    }
    const cancelled = stamp(issue.cancelledAt)
    if (issue.status === 'cancelled' && cancelled >= since) events.push({ at: cancelled, kind: 'stopped', id: issue.id, text: `${ref} was cancelled: ${title}` })
    const started = stamp(issue.startedAt)
    if (issue.status === 'in_progress' && started >= since) events.push({ at: started, kind: 'started', id: issue.id, text: `${bot} started ${ref} ${title}` })
  }
  for (const line of files.merges) {
    const match = MERGED.exec(line.text)
    const into = projectNames.get(byRef.get(match?.[1])?.projectId) || match?.[3]
    if (match && line.at >= since) events.push({ at: line.at, kind: 'merged', id: byRef.get(match[1])?.id || '', text: `${named(match[1])} merged into ${into}` })
  }
  for (const line of files.stopped) {
    const match = STOPPED.exec(line.text)
    if (match && line.at >= since) events.push({ at: line.at, kind: 'stopped', id: byRef.get(match[1])?.id || '', text: short(`${named(match[1])} stopped by ${match[2]}: ${withRefs(match[3])}`, 140) })
  }
  for (const line of files.switches) {
    if (line.at >= since) events.push({ at: line.at, kind: 'switch', id: '', text: short(withRefs(line.text).replace(MODEL_ID, (id) => modelLabel(id)), 140) })
  }
  return events.sort((a, b) => b.at - a.at).slice(0, SHOWN_FEED)
}

/** Each project: how much is moving, who is in it, and how many commits wait to be pushed. */
function projectRows({ projects, issues, bots, repos, now, liveJobs = null }) {
  return projects.map((project) => {
    const jobs = issues.filter((i) => i.projectId === project.id)
    const count = (test) => jobs.filter(test).length
    return {
      id: project.id,
      name: project.name,
      running: count((i) => (liveJobs ? (liveJobs.has(i.id) || (i.status === 'in_progress' && liveJobs.has(`bot:${i.assigneeAgentId}`))) && i.status !== 'done' && i.status !== 'cancelled' : i.status === 'in_progress')),
      queued: count((i) => WAITING.has(i.status) || (liveJobs && i.status === 'in_progress' && !liveJobs.has(i.id) && !liveJobs.has(`bot:${i.assigneeAgentId}`))),
      blocked: count((i) => i.status === 'blocked'),
      doneToday: count((i) => i.status === 'done' && now - stamp(i.completedAt) < DAY_MS),
      unpushed: repos.get(project.id)?.unpushed ?? null,
      bots: bots.filter((b) => b.projectId === project.id).map((b) => b.name),
      at: Math.max(0, ...jobs.map(lastTouched)),
    }
  }).sort((a, b) => b.running - a.running || b.at - a.at)
}

/** What is wrong, worst first, one sentence each. An empty list means nothing needs a look. */
function troubleList({ issues, projectNames, lines, bots, files, now }) {
  const out = []
  const { pace, thinker, freeOut, freeOk } = files
  const blocked = issues.filter((i) => i.status === 'blocked')
  if (blocked.length) {
    out.push({ level: 'bad', text: `${plural(blocked.length, 'job is', 'jobs are')} blocked: ${blocked.slice(0, 4).map((i) => refOf(i, projectNames)).join(', ')}${blocked.length > 4 ? ' and more' : ''}` })
  }
  for (const line of lines.filter((l) => l.stage === 'fix')) out.push({ level: 'bad', text: `${line.ref} failed its check and no fix has started` })
  for (const line of lines.filter((l) => l.late)) {
    out.push({ level: 'warn', text: `${line.ref} has been ${line.stage === 'queued' ? 'waiting' : 'running'} for ${Math.round((now - line.since) / 60_000)} minutes` })
  }
  if (typeof pace.week === 'number' && pace.week >= (pace.cap ?? 1) * 0.9 && pace.resets * 1000 > now) {
    const paused = bots.filter((b) => b.where === 'Claude' && b.status === 'paused').length
    out.push({ level: 'warn', text: `Claude's week is ${Math.round(pace.week * 100)}% used${paused ? `, so ${plural(paused, 'Claude bot is', 'Claude bots are')} paused` : ''} until ${clock(pace.resets * 1000)}` })
  }
  if (thinker.on && thinker.on !== 'codex') {
    out.push({ level: 'warn', text: `Codex is out; the thinking bots run on ${thinker.on === 'gemini' ? 'Antigravity' : thinker.on}${thinker.back ? ` until ${clock(thinker.back * 1000)}` : ''}` })
  }
  const aside = Object.entries(freeOut).filter(([, v]) => v?.until * 1000 > now).map(([model]) => model)
  const answering = Object.keys(freeOk).filter((model) => !aside.includes(model))
  if (aside.length && !answering.length) out.push({ level: 'bad', text: 'Every free model is out, so the bots on free models cannot work' })
  else if (aside.length) out.push({ level: 'info', text: `${plural(aside.length, 'free model is', 'free models are')} set aside; ${answering.length} still answer` })
  // Done jobs whose code never reached main (crew/not-in-main.py): a job is not done while its work is not in main.
  // An older try whose goal landed later (not-in-main.py marks it `superseded`) is not lost work.
  const left = (files.notInMain?.jobs || []).filter((j) => j && j.job && !j.superseded)
  if (left.length) {
    const byCode = new Map(issues.map((i) => [i.identifier, i]))
    const named = [...new Set(left.map((j) => (byCode.has(j.job) ? refOf(byCode.get(j.job), projectNames) : j.job)))]
    out.push({ level: 'bad', text: `${plural(named.length, 'job is', 'jobs are')} marked done but ${named.length === 1 ? 'its' : 'their'} code is not in main: ${named.slice(0, 4).join(', ')}${named.length > 4 ? ' and more' : ''}` })
  }
  for (const note of files.ownerNotes || []) out.push({ level: 'info', text: note.text })
  const unpushed = lines.filter((l) => l.stage === 'merged').length
  if (unpushed) out.push({ level: 'info', text: `${plural(unpushed, 'finished piece', 'finished pieces')} of work ${unpushed === 1 ? 'is' : 'are'} merged but not pushed` })
  const rank = { bad: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.level] - rank[b.level])
}

/** One sentence for the top of the screen. */
function stateLine({ working, trouble, lines }) {
  const bad = trouble.filter((t) => t.level === 'bad').length
  // The short title first and the code after it (the owner, 18 Nov 2026): "Lead checking Town kit LH-3".
  const said = (w) => {
    const checked = /^Checking ([A-Z]+-\d+)/.exec(w.stage || '')?.[1]
    const verb = checked ? 'checking' : w.stage === 'Ruling' ? 'ruling on' : 'on'
    return `${w.bot.split(' ')[0]} ${verb} ${short(w.title.replace(FIX, ''), 34)} ${checked || w.ref}`
  }
  // Only a job with a run going counts as worked on: the engine keeps some jobs "in progress" after their run ends.
  // A job started in the last quarter hour counts too: its run may still be starting.
  const busy = working.filter((w) => w.running || w.minutes < 15)
  const doing = busy.length
    ? `${plural(busy.length, 'bot is', 'bots are')} working: ${busy.slice(0, 3).map(said).join(', ')}${busy.length > 3 ? ' and more' : ''}`
    : 'Nobody is working right now'
  const open = lines.filter((l) => l.open && !['build', 'check', 'ruling'].includes(l.stage)).length
  return `${doing}.${bad ? ` ${plural(bad, 'thing needs', 'things need')} a look.` : open ? ` ${plural(open, 'piece', 'pieces')} of work ${open === 1 ? 'is' : 'are'} waiting.` : ''}`
}

/** The whole view from records already in hand. Pure, so the tests can feed it a studio. */
export function buildManager({ agents, issues, projects, live: liveGiven, files, verdicts = new Map(), repos = new Map(), requests = [], counts = null, now = Date.now() }) {
  // With no list of live runs given, a job's own word stands; with one, "now" means a run is going.
  const live = liveGiven || []
  // A copy of a bot on another AI is that bot to every list: its jobs, its name, one card.
  const fold = copyGroups(agents)
  const names = new Map(agents.map((a) => [a.id, (fold.parentOf.get(a.id) || a).name]))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  const byRef = new Map(issues.map((i) => [i.identifier, i]))
  for (const issue of issues) refOf(issue, projectNames)
  const liveAgents = new Set(live.map((run) => run.agentId))
  const mergedAt = new Map()
  for (const line of files.merges) {
    const match = MERGED.exec(line.text)
    if (match) mergedAt.set(match[1], line.at)
  }
  const liveJobs = new Set(live.map((run) => run.issueId).filter(Boolean))
  // A live run that names no job still counts for the job its bot holds.
  const unnamed = new Set(live.filter((run) => !run.issueId).map((run) => run.agentId))
  // For the steps and the project counts: a job with a run going, or held by a bot whose run names no job.
  const liveWork = !liveGiven ? null : new Set([...liveJobs, ...[...unnamed].map((id) => `bot:${id}`)])
  const working = workingNow({ issues, names, projectNames, agents, liveAgents, liveJobs, unnamed, fold, now })
  const jobs = foldKeys(issues, ['assigneeAgentId'], fold)
  const lines = workLines({ issues: jobs, names, roles: new Map(fold.top.map((a) => [a.id, roleOf(a)])), projectNames, verdicts, mergedAt, repos, now, requests, liveJobs: liveWork })
  const bots = botRows({ agents: fold.top, issues: jobs, projectNames, liveAgents, working, files, fold, now })
  const trouble = troubleList({ issues, projectNames, lines, bots, files, now })
  // Jobs left in progress with no run for an hour: counted as stuck, never as work going on.
  const stale = working.filter((w) => !w.running && w.minutes >= 60).length
  if (stale) trouble.push({ level: 'warn', text: `${plural(stale, 'job is', 'jobs are')} marked in progress with no run going for over an hour` })
  return {
    state: stateLine({ working, trouble, lines }),
    trouble,
    now: working,
    lines,
    bots,
    projects: projectRows({ projects, issues, bots, repos, now, liveJobs: liveWork }),
    feed: dayFeed({ issues, names, projectNames, byRef, files, verdicts, now }),
    // Every pile of jobs with its count: the Work sheet's tabs, each one tap from the list.
    piles: pilesOf(counts),
    at: now,
  }
}

// A finished check does not change its mind, so its verdict is read once.
const verdictsSeen = new Map()
const gitSeen = new Map()

/** A finished check with no verdict in its thread is looked at again only this often, not on every poll. */
const NO_VERDICT_RETRY_MS = 5 * 60_000
const verdictsMissed = new Map()

export async function readVerdicts(issues, options, now) {
  const wanted = issues.filter((i) => i.status === 'done' && kindOf(i.title).kind === 'check'
    && now - (stamp(i.completedAt) || lastTouched(i)) < VERDICT_AGE_MS && !verdictsSeen.has(i.id)
    && !(now - (verdictsMissed.get(i.id) ?? -Infinity) < NO_VERDICT_RETRY_MS))
  await Promise.all(wanted.map(async (issue) => {
    const verdict = verdictOf(await jobComments(issue.id, VERDICT_LOOKBACK, options))
    if (verdict) verdictsSeen.set(issue.id, verdict)
    // Without this a check that ended without saying pass or fail was read again every three seconds, for a day.
    else verdictsMissed.set(issue.id, now)
  }))
  return verdictsSeen
}

const folderOf = (project) => (project.primaryWorkspace || project.workspaces?.[0])?.cwd || ''
/** The jobs whose branches are in a list of branches: a job's branch starts with its code (`LH-12-what-it-is`). */
const jobsOn = (branches) => new Set(branches.split('\n').map((line) => /^[*+\s]*([A-Z]{2,6}-\d+)/.exec(line)?.[1]).filter(Boolean))

/**
 * What git says about a project's folder: commits its remote does not have, and which jobs'
 * branches are already in main and in the remote's main. Asked once a minute per folder.
 */
async function repoState(project, now) {
  const cwd = folderOf(project)
  if (!cwd) return NO_REPO
  const seen = gitSeen.get(cwd)
  if (seen && now - seen.at < GIT_TTL_MS) return seen.state
  const ask = (args) => git(cwd, args).catch(() => null)
  const main = (await ask(['rev-parse', '--verify', '-q', 'main'])) === null ? 'master' : 'main'
  const [count, merged, pushed] = await Promise.all([
    ask(['rev-list', '--count', `origin/${main}..${main}`]),
    ask(['branch', '--merged', main]),
    ask(['branch', '--merged', `origin/${main}`]),
  ])
  const state = { unpushed: count === null ? null : Number(count.trim()), remote: count !== null, merged: jobsOn(merged || ''), pushed: jobsOn(pushed || '') }
  gitSeen.set(cwd, { at: now, state })
  return state
}

/** The manager's view, read fresh. */
/** The manager's view with the engine's records it was worked out from, for the office's map. */
export async function managerWithRecords({ folder = crewFolder(), now = Date.now(), ...options } = {}) {
  const records = await crewRecords(options)
  const files = readCrewFiles(folder)
  const [verdicts, repos, requests, counts] = await Promise.all([
    readVerdicts(records.issues, options, now),
    Promise.all(records.projects.map(async (p) => [p.id, await repoState(p, now)])),
    // Requests on tracks: an engine without tracks has none.
    companyId(options).then((co) => orElse(call(`/companies/${co}/requests?limit=200`, options), [])),
    // How many jobs each pile holds: the Work sheet's tabs. An engine without counts has none, and no tabs show.
    companyId(options).then((co) => orElse(call(`/companies/${co}/job-counts?since=${encodeURIComponent(startOfToday(now))}`, options), null)),
  ])
  return { manager: buildManager({ ...records, files, verdicts, repos: new Map(repos), requests, counts, now }), records }
}

export const managerSummary = async (options) => (await managerWithRecords(options)).manager

/**
 * Everything that has to close for one line of work to leave the list: each round of the job that
 * is not cancelled yet, and the checks still open on any of them. Closing only the newest round
 * would bring the one before it back as the line.
 */
export function workToClear(issues, jobId) {
  const job = issues.find((i) => i.id === jobId)
  if (!job) return []
  const isWork = (i) => !['check', 'ruling'].includes(kindOf(i.title).kind)
  const rounds = issues.filter((i) => isWork(i) && (i.projectId || '') === (job.projectId || '') && workName(i.title) === workName(job.title))
  const refs = new Set(rounds.map((r) => r.identifier))
  const checks = issues.filter((i) => kindOf(i.title).kind === 'check' && refs.has(kindOf(i.title).of) && OPEN.has(i.status))
  return [...rounds.filter((r) => r.status !== 'cancelled'), ...checks]
}

/** Clear a line of work the owner no longer needs. The engine keeps every job, so it can be reopened there. */
export async function clearWork(jobId, options) {
  const { issues } = await crewRecords(options)
  const closing = workToClear(issues, jobId)
  if (!closing.length) throw new EngineError(404, 'That job is not on the board any more')
  for (const issue of closing) {
    await stopJob(issue.id, options)
    await cancelJob(issue.id, options)
  }
  return { ok: true, cleared: closing.map((i) => i.identifier) }
}
