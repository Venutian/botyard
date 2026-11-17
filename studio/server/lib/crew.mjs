/**
 * The crew in full, for the map's Bots, Runs and Money sections: each bot's engine and why, its runs,
 * cost, instructions, skills and settings history; every run across the crew with its log; the
 * activity timeline; and the spend by bot, model, provider and project.
 *
 * The engine is reached only through `engine.mjs`'s `call`. Its answers are large (the timeline is
 * 360 KB, a run's log can be 200 KB) and carry paths, session ids and adapter settings, so every
 * reader here keeps only what a screen shows and trims long text. Reads are kept a few seconds on
 * the real server, so a panel opened twice does not ask twice. Files the crew's scripts write
 * (waste.json, rested.json, thinker.json, free-out.json, pace.json) are read straight from disk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ALL_JOBS, EngineError, call, companyId, crewOf, orElse, plainTitle, refOf, withRefs } from './engine.mjs'
import { crewFolder, modelLabel } from './models.mjs'
import { crewLooks } from './looks.mjs'
import { runFeed, scrub, toolLine } from './run-feed.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const READ_TTL_MS = 8_000
const TIMELINE_TTL_MS = 30_000
const SHOWN_BOT_RUNS = 20
const RUN_LIST = 200
const RUNS_PAGE = 50
const ACTIVITY_PAGE = 40
const LOG_TAIL_BYTES = 96 * 1024
// How much of a run's log its feed reads: the last half megabyte, which is hundreds of steps.
const FEED_TAIL_BYTES = 512 * 1024
const SHOWN_LOG = 60
const LOG_LINE_CHARS = 400
const TOOL_LINE_CHARS = 200
const SHOWN_REVISIONS = 12
const SHOWN_CAUSES = 3
const MAX_INSTRUCTIONS = 200_000
/** STANDARDS.md rule 5, as health.py measures it: a bot past this share of 8 or more runs is flagged. */
export const WASTE_SHARE = 0.3
export const WASTE_MIN_RUNS = 8

export const ENGINE = { claude_local: 'Claude', codex_local: 'Codex', gemini_local: 'Antigravity', opencode_local: 'Free models' }
const FAILED = new Set(['failed', 'timed_out', 'cancelled', 'interrupted'])
const STATUS_WORDS = { succeeded: 'Done', failed: 'Failed', timed_out: 'Ran out of time', cancelled: 'Stopped', interrupted: 'Cut off', running: 'Running', queued: 'Waiting to start' }

const clock = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const num = (value) => Number(value) || 0
const stamp = (value) => (value ? Date.parse(value) || 0 : 0)
export const cut = (text, max) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s }

// ── keeping reads a few seconds ────────────────────────────────────────────────────

const kept = new Map()
/** The real server keeps each answer `ms`; a caller with its own fetcher (a test) always asks afresh. */
export function cached(key, ms, options, read) {
  if (options?.fetcher) return read()
  const hit = kept.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value
  const value = read()
  kept.set(key, { at: Date.now(), value })
  value.catch(() => kept.delete(key))
  return value
}
/** After a write, the next read must see it. */
export const forgetReads = () => kept.clear()

// ── the crew's own files ───────────────────────────────────────────────────────────

function readJson(file, empty) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && Array.isArray(value) === Array.isArray(empty) ? value : empty
  } catch {
    return empty
  }
}

/**
 * An error as the owner reads it. Engine messages are long and technical; the owner needs to know
 * which limit ran out, or that it was stopped by hand, not the HTTP status.
 */
export function plainError(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  const reset = /resets ([^·()\n]+?)(?:\s*\(|$|\n)/i.exec(t)?.[1]?.trim()
  if (/hit your .*limit|weekly limit|usage limit|session limit/i.test(t)) return `Claude's limit ran out${reset ? ` (it resets ${reset})` : ''}`
  if (/free-models-per-day|rate limit exceeded|too many requests|\b429\b/i.test(t)) return "A free model's limit was reached"
  if (/model is unavailable|model .*does not exist|no such model|model not found/i.test(t)) return 'That free model is no longer offered'
  const handed = /^(\S+) ran out; continuing the same session on (\S+?)\.?$/.exec(t)
  if (handed) return `${modelLabel(handed[1])} ran out; carried on with ${modelLabel(handed[2])}`
  if (/maximum context length|context window|prompt is too long/i.test(t)) return 'The job was too long for the model'
  if (/timed out/i.test(t)) return 'Ran out of time'
  if (/cancelled by a board operator/i.test(t)) return 'Stopped by hand'
  if (/cancelled by control plane/i.test(t)) return 'Stopped by the studio'
  if (/dependencies are still blocked/i.test(t)) return 'Stopped: the jobs it waits on are not done'
  if (/retry suppressed because issue reached terminal/i.test(t)) return 'Not retried: the job was already finished'
  if (/repair suppressed|retry suppressed/i.test(t)) return 'Not run again: the job had moved on'
  if (/exited with code 143|SIGTERM/i.test(t)) return 'Stopped: the engine was shut down'
  if (/^adapter failed$/i.test(t)) return 'The engine stopped with an error'
  if (/EPROTO|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TLS handshake|fetch failed/i.test(t)) return "Could not reach the model's server"
  return cut(t.replace(/\b(?:opencode|openrouter|nvidia)\/[\w.:/-]+|\bclaude-[a-z]+-[\d-]+\b/g, (id) => modelLabel(id)), 160)
}

/**
 * health.py's count of each bot's last day: runs that bought nothing (failed, timed out or
 * cancelled), their tokens, and why. A bot is flagged past 30 % of 8 or more runs.
 */
export function readWaste(folder = crewFolder(), now = Date.now()) {
  const raw = readJson(path.join(folder, 'waste.json'), {})
  const bots = {}
  for (const [name, row] of Object.entries(raw.bots && typeof raw.bots === 'object' ? raw.bots : {})) {
    if (!row || typeof row !== 'object') continue
    const runs = num(row.runs)
    const wasted = Math.min(runs, num(row.wasted))
    const causes = new Map()
    for (const [text, count] of Object.entries(row.causes && typeof row.causes === 'object' ? row.causes : {})) {
      const plain = plainError(text)
      causes.set(plain, (causes.get(plain) || 0) + num(count))
    }
    bots[name] = {
      runs,
      wasted,
      share: runs ? wasted / runs : 0,
      tokens: num(row.tokens),
      wastedTokens: num(row.wastedTokens),
      causes: [...causes].sort((a, b) => b[1] - a[1]).slice(0, SHOWN_CAUSES).map(([text, count]) => ({ text, count })),
      flagged: runs >= WASTE_MIN_RUNS && wasted / runs >= WASTE_SHARE,
    }
  }
  const at = num(raw.at) * 1000
  return { at: at || null, stale: !at || now - at > 2 * 60 * 60 * 1000, bots }
}

/** Bots health.py paused because their engine ran out, each with when it wakes. Past ones are dropped. */
export function readRested(folder = crewFolder(), now = Date.now()) {
  const raw = readJson(path.join(folder, 'rested.json'), {})
  const out = {}
  for (const [id, row] of Object.entries(raw)) {
    const until = num(row?.until) * 1000
    if (until > now) out[id] = { until, text: `Resting until ${clock(until)}`, why: plainError(row.why) }
  }
  return out
}

/** Which engine a bot is on and why, in one line, from its settings and the crew's switch files. */
function engineOf(agent, { thinker, freeOut }, now) {
  const engine = ENGINE[agent.adapterType] || 'Other'
  const model = typeof agent.adapterConfig?.model === 'string' ? agent.adapterConfig.model : ''
  const codexOut = thinker.on === 'gemini'
  const back = num(thinker.back) * 1000
  const until = back > now ? ` until ${clock(back)}` : ''
  let why = ''
  if (agent.adapterType === 'opencode_local') {
    const aside = freeOut[model]
    why = aside && num(aside.until) * 1000 > now ? `Its first pick is set aside until ${clock(num(aside.until) * 1000)}, so it runs on the next that answers` : 'Free models, the best that answers first'
  } else if (agent.adapterType === 'gemini_local') {
    why = codexOut ? `Codex is out${until}, so it runs on Antigravity` : 'Antigravity'
  } else if (agent.adapterType === 'claude_local') {
    why = codexOut && Array.isArray(thinker.claude) && thinker.claude.includes(agent.name) ? `Codex and Antigravity are out, so it runs on Claude${until}` : 'Claude subscription'
  } else if (agent.adapterType === 'codex_local') {
    why = 'Codex subscription'
  }
  return { engine, model: model ? modelLabel(model) : '', why }
}

/** Every file the panel's bot views read, once per answer. */
function crewFiles(folder, now) {
  const at = (name) => path.join(folder, name)
  return {
    thinker: readJson(at('thinker.json'), {}),
    freeOut: readJson(at('free-out.json'), {}),
    pace: readJson(at('pace.json'), {}),
    waste: readWaste(folder, now),
    rested: readRested(folder, now),
  }
}

const stateOf = (agent, live, rested) => {
  if (live.has(agent.id)) return { status: 'running', state: 'Working' }
  if (agent.status === 'paused' && rested[agent.id]) return { status: 'paused', state: rested[agent.id].text, resting: true }
  return { status: agent.status, state: { idle: 'Free', paused: 'Paused', error: 'Stopped on an error', running: 'Working' }[agent.status] || agent.status }
}

// ── shared reads ──────────────────────────────────────────────────────────────────

const tokensOf = (row) => num(row.inputTokens) + num(row.outputTokens)

/** The company's jobs and projects, as names: every view that names a job needs them. */
export async function jobNames(id, options) {
  return cached(`jobs:${id}`, READ_TTL_MS, options, async () => {
    const [issues, projects] = await Promise.all([
      orElse(call(`/companies/${id}/issues?${ALL_JOBS}`, options), []),
      orElse(call(`/companies/${id}/projects`, options), []),
    ])
    const projectNames = new Map(projects.map((p) => [p.id, p.name]))
    const jobs = new Map(issues.map((i) => [i.id, { id: i.id, ref: refOf(i, projectNames), title: cut(plainTitle(withRefs(i.title || '')), 90), status: i.status, project: projectNames.get(i.projectId) || '' }]))
    return { jobs, projects: projectNames }
  })
}

const costRange = (id, since, options) => cached(`cost:${id}:${since}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/costs/by-agent?from=${encodeURIComponent(new Date(since).toISOString())}`, options), []))

/** Midnight here, today, and seven days back from now: the windows the panel counts in. */
const windows = (now) => {
  const d = new Date(now)
  return { today: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), week: now - WEEK_MS }
}

/** One run as a row: who, which job, how it ended and why, how long, and what it used. */
export function runRow(run, names, jobs) {
  const job = jobs.get(run.issueId)
  const start = stamp(run.startedAt || run.createdAt)
  const end = stamp(run.finishedAt)
  const failed = FAILED.has(run.status)
  return {
    id: run.id,
    bot: names.get(run.agentId) || 'A bot',
    botId: run.agentId,
    status: run.status,
    state: STATUS_WORDS[run.status] || run.status,
    failed,
    job: job ? { id: job.id, ref: job.ref, title: job.title } : null,
    at: start || null,
    seconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : null,
    tokens: tokensOf(run),
    cached: num(run.cachedInputTokens),
    usd: num(run.costUsd),
    why: failed ? plainError(run.error || run.errorCode || '') || 'It stopped without saying why' : '',
  }
}

// ── the Bots section ───────────────────────────────────────────────────────────────

/** The crew at a glance: each bot's engine and why, its state, its spend today and this week, its waste. */
// A bot's skills take the engine seconds to list (2.4 s each on 12 November 2026, more as skills were added),
// and change only when setup-bots.py runs: they are kept ten minutes. Reading the whole crew's at once
// stalled the engine for every other request (13 s pages), so each bot's are read when its page asks.
const SKILLS_TTL_MS = 10 * 60_000
const skillsSoon = (botId, options) => cached(`skills:${botId}`, SKILLS_TTL_MS, options, () => orElse(call(`/agents/${botId}/skills`, options), null))

export async function botList({ folder = crewFolder(), now = Date.now(), ...options } = {}) {
  const id = await companyId(options)
  const { today, week } = windows(now)
  const [agents, live, org, dayCost, weekCost] = await Promise.all([
    crewOf(id, options),
    orElse(call(`/companies/${id}/live-runs`, options), []),
    cached(`org:${id}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/org`, options), [])),
    costRange(id, today, options),
    costRange(id, week, options),
  ])
  const files = crewFiles(folder, now)
  const liveIds = new Set(live.map((r) => r.agentId))
  const day = new Map(dayCost.map((r) => [r.agentId, tokensOf(r)]))
  const wk = new Map(weekCost.map((r) => [r.agentId, tokensOf(r)]))
  const shown = new Set(agents.map((a) => a.id))
  const order = { running: 0, error: 1, idle: 2, paused: 3 }
  const looks = crewLooks(agents)
  const bots = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    title: agent.title || '',
    ...looks.get(agent.id),
    ...stateOf(agent, liveIds, files.rested),
    ...engineOf(agent, files, now),
    tokensToday: day.get(agent.id) || 0,
    tokensWeek: wk.get(agent.id) || 0,
    waste: files.waste.bots[agent.name] || null,
  })).sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || a.name.localeCompare(b.name))
  // Who reports to whom, as the engine's org chart has it, without the retired.
  const tree = (nodes) => nodes.filter((n) => shown.has(n.id)).map((n) => ({ id: n.id, name: n.name, reports: tree(n.reports || []) }))
  return { bots, org: tree(org), wasteAt: files.waste.at, wasteStale: files.waste.stale, at: now }
}

/** Which skills a bot is given, by short name. The engine lists every skill on the machine; only the given ones matter. */
const skillsOf = (skills) => (Array.isArray(skills?.desiredSkills) ? skills.desiredSkills : [])
  .map((key) => String(key).split('/').pop()).filter(Boolean)

/** What changed in a settings revision, in plain words, without the values (they can hold keys). */
const KEY_WORDS = { adapterConfig: 'engine settings', adapterType: 'engine', runtimeConfig: 'run settings', name: 'name', title: 'title', role: 'role', reportsTo: 'who it reports to', capabilities: 'description', budgetMonthlyCents: 'budget', metadata: 'notes', icon: 'picture', appearance: 'look', permissions: 'permissions' }
function revisionView(rev) {
  const before = rev.beforeConfig || {}
  const after = rev.afterConfig || {}
  const modelBefore = before.adapterConfig?.model
  const modelAfter = after.adapterConfig?.model
  const what = (rev.changedKeys || []).map((k) => KEY_WORDS[k] || k)
  const engineBefore = ENGINE[before.adapterType]
  const engineAfter = ENGINE[after.adapterType]
  const detail = [
    engineBefore && engineAfter && engineBefore !== engineAfter ? `${engineBefore} to ${engineAfter}` : '',
    typeof modelAfter === 'string' && modelBefore !== modelAfter ? `model ${modelBefore ? `${modelLabel(modelBefore)} to ` : ''}${modelLabel(modelAfter)}` : '',
  ].filter(Boolean).join(', ')
  return {
    id: rev.id,
    at: rev.createdAt,
    by: rev.createdByAgentId ? 'A bot' : rev.source === 'rollback' || rev.rolledBackFromRevisionId ? 'Rolled back' : 'You or a crew script',
    what: what.length ? `Changed ${what.join(', ')}` : 'Saved',
    detail,
  }
}

/**
 * The instructions file a bot reads before every run. Only the entry file: the bundle's folder is
 * the crew's whole script folder, and nothing else in it is shown. History, edits and restores
 * exist only for a bundle the engine stores itself ("managed"); today every bot's file lives in the
 * crew folder, where the crew repository's git keeps its history.
 */
export async function instructionsOf(botId, options) {
  // The engine hashes every file of the bundle's folder for this (a second for the crew folder): keep it a minute.
  const bundle = await cached(`bundle:${botId}`, 60_000, options, () => orElse(call(`/agents/${botId}/instructions-bundle`, options), null))
  if (!bundle?.entryFile) return null
  const file = await orElse(call(`/agents/${botId}/instructions-bundle/file?path=${encodeURIComponent(bundle.entryFile)}`, options), null)
  const managed = bundle.mode === 'managed'
  const history = managed ? await orElse(call(`/agents/${botId}/instructions-bundle/history`, options), { revisions: [] }) : null
  return {
    file: bundle.entryFile,
    managed,
    content: typeof file?.content === 'string' ? file.content.slice(0, MAX_INSTRUCTIONS) : '',
    revisionId: file?.revisionId || file?.revision?.id || history?.revisions?.[0]?.id || null,
    history: (history?.revisions || []).slice(0, SHOWN_REVISIONS).map((r) => ({ id: r.id, at: r.createdAt, by: { board: 'You', api: 'A bot or script', file: 'Changed in its file', restore: 'An older version, taken back' }[r.source] || String(r.source || ''), bytes: Number(r.bytes) || 0 })),
  }
}

/** One bot's page. */
export async function botPage(botId, { folder = crewFolder(), now = Date.now(), ...options } = {}) {
  if (!ID.test(botId)) throw new EngineError(400, 'That is not a bot id')
  const id = await companyId(options)
  const { today, week } = windows(now)
  const [agent, agents, live, runs, sessions, skills, revisions, instructions, names, dayCost, weekCost] = await Promise.all([
    call(`/agents/${botId}`, options),
    crewOf(id, options),
    orElse(call(`/companies/${id}/live-runs`, options), []),
    orElse(call(`/companies/${id}/heartbeat-runs?agentId=${botId}&limit=${SHOWN_BOT_RUNS}&summary=true`, options), []),
    orElse(call(`/agents/${botId}/task-sessions`, options), []),
    // The page does not wait seconds for its skills: what is kept shows now, the rest on the next open.
    Promise.race([skillsSoon(botId, options), new Promise((resolve) => setTimeout(resolve, options.fetcher ? 5000 : 400, undefined))]),
    orElse(call(`/agents/${botId}/config-revisions`, options), []),
    Promise.race([cached(`instructions:${botId}`, 60_000, options, () => instructionsOf(botId, options)), new Promise((resolve) => setTimeout(resolve, options.fetcher ? 5000 : 1200, undefined))]),
    jobNames(id, options),
    costRange(id, today, options),
    costRange(id, week, options),
  ])
  const files = crewFiles(folder, now)
  const nameOf = new Map(agents.map((a) => [a.id, a.name]))
  const job = live.find((r) => r.agentId === botId)
  const current = job ? names.jobs.get(job.issueId) : null
  const cost = (rows) => rows.find((r) => r.agentId === botId) || {}
  const spend = (row) => ({ tokens: tokensOf(row), cached: num(row.cachedInputTokens), cents: num(row.costCents), runs: num(row.eventCount) })
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title || '',
    ...crewLooks(agents).get(agent.id),
    ...stateOf(agent, new Set(live.map((r) => r.agentId)), files.rested),
    ...engineOf(agent, files, now),
    restingWhy: files.rested[agent.id]?.why || '',
    reportsTo: nameOf.get(agent.reportsTo) || '',
    reports: agents.filter((a) => a.reportsTo === agent.id).map((a) => a.name),
    job: current ? { id: current.id, ref: current.ref, title: current.title } : null,
    today: spend(cost(dayCost)),
    week: spend(cost(weekCost)),
    waste: files.waste.bots[agent.name] || null,
    runs: runs.slice(0, SHOWN_BOT_RUNS).map((r) => runRow(r, nameOf, names.jobs)),
    sessions: sessions.length,
    skills: skillsOf(skills),
    skillsPending: skills === undefined,
    // Newest first, whichever way the engine lists them: the page calls the first one current.
    revisions: [...revisions].sort((x, y) => stamp(y.createdAt) - stamp(x.createdAt)).slice(0, SHOWN_REVISIONS).map(revisionView),
    instructions: instructions ?? null,
    // Parts the engine was too slow to give in time: the page asks again in a moment.
    pending: instructions === undefined || skills === undefined,
    at: now,
  }
}

// ── Runs and activity ──────────────────────────────────────────────────────────────

/** Every run across the crew, newest first, filtered by bot and by how it ended, a page at a time. */
export async function runList({ bot = '', status = '', page = 0, ...options } = {}) {
  if (bot && !ID.test(bot)) throw new EngineError(400, 'That is not a bot id')
  const id = await companyId(options)
  const [agents, runs, names] = await Promise.all([
    crewOf(id, options),
    cached(`runs:${id}:${bot}`, READ_TTL_MS, options, () => call(`/companies/${id}/heartbeat-runs?limit=${RUN_LIST}&summary=true${bot ? `&agentId=${bot}` : ''}`, options)),
    jobNames(id, options),
  ])
  const nameOf = new Map(agents.map((a) => [a.id, a.name]))
  const rows = runs.filter((r) => nameOf.has(r.agentId))
    .filter((r) => !status || (status === 'failed' ? FAILED.has(r.status) : status === 'running' ? ['running', 'queued'].includes(r.status) : r.status === status))
  const from = Math.max(0, Number(page) || 0) * RUNS_PAGE
  return {
    runs: rows.slice(from, from + RUNS_PAGE).map((r) => runRow(r, nameOf, names.jobs)),
    total: rows.length,
    page: Math.floor(from / RUNS_PAGE),
    pages: Math.max(1, Math.ceil(rows.length / RUNS_PAGE)),
    bots: agents.map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}



/**
 * The tail of a run's log as lines a person reads: what the bot said, what it ran, and errors. The
 * engines write JSON events (Claude's stream, OpenCode's parts); everything else is shown as is.
 */
export function readableLog(content) {
  const streams = { stdout: '', stderr: '' }
  const lines = String(content || '').split('\n')
  // The tail starts mid-line: the first piece is a fragment of a record.
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (typeof rec?.chunk === 'string') streams[rec.stream === 'stderr' ? 'stderr' : 'stdout'] += rec.chunk
  }
  const out = []
  const add = (kind, text) => {
    const t = cut(scrub(text), kind === 'tool' ? TOOL_LINE_CHARS : LOG_LINE_CHARS)
    // Claude's closing result repeats its last words: say them once.
    if (t && !(out.length && out[out.length - 1].text === t)) out.push({ kind, text: t })
  }
  for (const line of streams.stdout.split('\n')) {
    if (!line.trim()) continue
    let ev = null
    try { ev = JSON.parse(line) } catch { /* plain text */ }
    if (!ev || typeof ev !== 'object') { if (!line.startsWith('{')) add('note', line.replace(/^\[engine\]\s*/, '')); continue }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const part of ev.message.content) {
        if (part.type === 'text') add('said', part.text)
        if (part.type === 'tool_use') add('tool', toolLine(part.name, part.input))
      }
    } else if (ev.type === 'result') {
      if (ev.result) add('said', ev.result)
      if (ev.is_error && ev.error) add('error', ev.error)
    } else if (ev.type === 'text' && ev.part?.text) {
      add('said', ev.part.text)
    } else if (ev.type === 'tool_use' && ev.part?.tool) {
      add('tool', toolLine(ev.part.tool, ev.part.state?.input))
    } else if (ev.type === 'error') {
      add('error', ev.error?.message || ev.message || 'An error')
    }
  }
  for (const line of streams.stderr.split('\n')) if (line.trim()) add('error', line)
  return out.slice(-SHOWN_LOG)
}

/** One run's page: how it ended and why, what it cost, its job, and the end of its log. */
export async function runDetail(runId, options = {}) {
  if (!ID.test(runId)) throw new EngineError(400, 'That is not a run id')
  const run = await call(`/heartbeat-runs/${runId}`, options)
  const live = run.status === 'running' || run.status === 'queued'
  // The end of the log as the file stands now: a run still going has booked no length yet, and is read all the same.
  const [agents, names, log] = await Promise.all([
    crewOf(run.companyId, options),
    jobNames(run.companyId, options),
    run.logRef || num(run.logBytes) ? orElse(call(`/heartbeat-runs/${runId}/log?tail=${FEED_TAIL_BYTES}`, options), null) : null,
  ])
  const content = log?.content || ''
  const from = Number(log?.offset) || 0
  // The short log (the phone's) keeps to its own tail.
  const shortFrom = Math.max(0, content.length - LOG_TAIL_BYTES)
  const shortContent = content.slice(shortFrom)
  const nameOf = new Map(agents.map((a) => [a.id, a.name]))
  const usage = run.usageJson && typeof run.usageJson === 'object' ? run.usageJson : {}
  const row = runRow({ ...run, inputTokens: run.inputTokens ?? usage.inputTokens, outputTokens: run.outputTokens ?? usage.outputTokens, cachedInputTokens: run.cachedInputTokens ?? usage.cachedInputTokens, costUsd: run.costUsd ?? usage.costUsd }, nameOf, names.jobs)
  // A log read from its start has no fragment to drop: give it a blank first line.
  const lines = log ? readableLog(from || shortFrom ? shortContent : `\n${shortContent}`) : []
  const feed = log ? runFeed(content, { fromStart: from === 0, cwd: run.contextSnapshot?.cwd || '' }) : { items: [], cut: 0 }
  return {
    ...row,
    model: usage.model ? modelLabel(usage.model) : '',
    started: { assignment: 'Given a job', automation: 'Woken by the crew', on_demand: 'Started by hand', timer: 'On a timer' }[run.invocationSource] || '',
    trimmed: from + shortFrom > 0,
    log: lines,
    live,
    feed: feed.items,
    feedTrimmed: from > 0 || feed.cut > 0,
    logSize: Number(log?.size) || num(run.logBytes),
  }
}

const ACT_WORDS = { created: 'made', commented: 'commented on', delegated: 'handed on', approved: 'approved' }

/**
 * Who did what to which job, newest first, a page at a time. The engine's timeline is the last
 * week (360 KB); it is read every 30 seconds at most, and a run of comments by one bot on one job
 * is one line with a count.
 */
export async function activityPage({ page = 0, bot = '', ...options } = {}) {
  const id = await companyId(options)
  const [timeline, names] = await Promise.all([
    cached(`timeline:${id}`, TIMELINE_TTL_MS, options, () => call(`/companies/${id}/timeline`, options)),
    jobNames(id, options),
  ])
  const actors = new Map((timeline?.actors || []).map((a) => [a.id, a.type === 'user' ? 'You or a script' : a.name]))
  const edges = timeline?.edges || []
  const items = []
  for (const ev of timeline?.events || []) {
    const at = stamp(ev.at)
    if (!at || (bot && ev.actorId !== `agent:${bot}`)) continue
    const job = names.jobs.get(ev.issueId)
    let what = ACT_WORDS[ev.kind] || ev.kind
    const to = edges.find((e) => e.issueId === ev.issueId && Math.abs(stamp(e.at) - at) < 2000 && e.fromActorId === ev.actorId)
    const toName = to && actors.get(to.toActorId)
    items.push({ at, who: actors.get(ev.actorId) || 'Someone', what, to: (ev.kind === 'created' || ev.kind === 'delegated') && toName ? toName : '', job: job ? { id: job.id, ref: job.ref, title: job.title } : null, actor: ev.actorId, issue: ev.issueId, kind: ev.kind, times: 1 })
  }
  for (const span of timeline?.spans || []) {
    if (!FAILED.has(span.status) || (bot && span.actorId !== `agent:${bot}`)) continue
    const job = names.jobs.get(span.issueId)
    items.push({ at: stamp(span.end || span.start), who: actors.get(span.actorId) || 'A bot', what: span.status === 'cancelled' ? 'had a run stopped on' : 'had a run fail on', to: '', job: job ? { id: job.id, ref: job.ref, title: job.title } : { id: span.issueId, ref: withRefs(span.issueIdentifier || ''), title: cut(plainTitle(withRefs(span.issueTitle || '')), 90) }, actor: span.actorId, issue: span.issueId, kind: 'failed', run: span.runId, times: 1 })
  }
  items.sort((a, b) => b.at - a.at)
  const merged = []
  for (const item of items) {
    const last = merged[merged.length - 1]
    if (last && last.kind === item.kind && last.actor === item.actor && last.issue === item.issue && item.kind === 'commented') last.times += 1
    else merged.push(item)
  }
  const from = Math.max(0, Number(page) || 0) * ACTIVITY_PAGE
  return {
    items: merged.slice(from, from + ACTIVITY_PAGE).map(({ actor, issue, kind, ...rest }) => ({ ...rest, kind })),
    total: merged.length,
    page: Math.floor(from / ACTIVITY_PAGE),
    pages: Math.max(1, Math.ceil(merged.length / ACTIVITY_PAGE)),
    since: timeline?.window?.from || null,
  }
}

// ── Models, limits and money ───────────────────────────────────────────────────────

const PROVIDER_NAMES = { anthropic: 'Claude', openai: 'Codex', opencode: 'OpenCode free', openrouter: 'OpenRouter free', nvidia: 'NVIDIA', acpx: 'Antigravity', google: 'Antigravity', gemini: 'Antigravity', cloudflare: 'Cloudflare' }
const providerName = (p) => PROVIDER_NAMES[p] || (p ? p[0].toUpperCase() + p.slice(1) : 'Unknown')
const spendRow = (r) => ({ tokens: tokensOf(r), cached: num(r.cachedInputTokens), cents: num(r.costCents), runs: num(r.eventCount) })

/** The engine's tokens by provider and window as one row a provider: `{ name, '5h', '24h', '7d' }`, busiest first. */
function windowRows(windowsSpend) {
  const limits = new Map()
  for (const w of windowsSpend || []) {
    const name = providerName(w.provider)
    const row = limits.get(name) || { name }
    row[w.window] = (row[w.window] || 0) + tokensOf(w)
    limits.set(name, row)
  }
  return [...limits.values()].sort((a, b) => (b['7d'] || 0) - (a['7d'] || 0))
}

/** Each provider's new tokens in the last 5 hours, day and week, for the top bar's usage list. */
export async function tokenWindows(options = {}) {
  const id = await companyId(options)
  return windowRows(await cached(`money:${id}:costs/window-spend`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/costs/window-spend`, options), [])))
}

/** Merges rows that share a name, so two the engine billers of one engine read as one line. */
function byName(rows, nameOf) {
  const out = new Map()
  for (const r of rows) {
    const name = nameOf(r)
    const row = out.get(name) || { name, tokens: 0, cached: 0, cents: 0, runs: 0 }
    const add = spendRow(r)
    for (const k of ['tokens', 'cached', 'cents', 'runs']) row[k] += add[k]
    out.set(name, row)
  }
  return [...out.values()].filter((r) => r.tokens || r.cents).sort((a, b) => b.tokens - a.tokens)
}

/**
 * The week's spend four ways (bot, model, provider, project), today's by bot, the windows each
 * provider counts in, and the Claude pace. The crew runs on subscriptions, so tokens are the
 * measure; money shows only where the engine priced something.
 */
export async function moneyView({ folder = crewFolder(), now = Date.now(), ...options } = {}) {
  const id = await companyId(options)
  const { today, week } = windows(now)
  const from = `from=${encodeURIComponent(new Date(week).toISOString())}`
  const get = (p) => cached(`money:${id}:${p}`, READ_TTL_MS, options, () => orElse(call(`/companies/${id}/${p}`, options), []))
  const [agents, dayBots, weekBots, models, providers, projects, windowsSpend, quotas] = await Promise.all([
    crewOf(id, options),
    costRange(id, today, options),
    costRange(id, week, options),
    get(`costs/by-agent-model?${from}`),
    get(`costs/by-provider?${from}`),
    get(`costs/by-project?${from}`),
    get('costs/window-spend'),
    get('costs/quota-windows'),
  ])
  const files = crewFiles(folder, now)
  const shown = new Map(agents.map((a) => [a.id, a]))
  const day = new Map(dayBots.map((r) => [r.agentId, tokensOf(r)]))
  const bots = weekBots.filter((r) => shown.has(r.agentId)).map((r) => {
    const agent = shown.get(r.agentId)
    return { id: r.agentId, name: agent.name, engine: ENGINE[agent.adapterType] || 'Other', model: typeof agent.adapterConfig?.model === 'string' ? modelLabel(agent.adapterConfig.model) : '', today: day.get(r.agentId) || 0, ...spendRow(r), waste: files.waste.bots[agent.name]?.wastedTokens || 0 }
  }).sort((a, b) => b.tokens - a.tokens)
  const order = ['5h', '24h', '7d']
  const pace = files.pace
  return {
    bots,
    models: byName(models, (r) => modelLabel(r.model)),
    providers: byName(providers, (r) => providerName(r.provider)),
    projects: byName(projects, (r) => r.projectName || 'No project'),
    windows: { order, rows: windowRows(windowsSpend) },
    quotas: quotas.filter((q) => q.ok && Array.isArray(q.windows) && q.windows.length).map((q) => ({
      name: providerName(q.provider),
      windows: q.windows.map((w) => ({ label: String(w.label || w.window || w.name || ''), used: num(w.usedPercent ?? w.percentUsed ?? w.utilization), resets: w.resetsAt || null })),
    })),
    pace: num(pace.week) || num(pace.resets) ? {
      week: num(pace.week),
      cap: num(pace.cap) || null,
      perHourNow: num(pace.perHourNow),
      perHourAllowed: num(pace.perHourAllowed),
      resets: num(pace.resets) * 1000 || null,
      at: num(pace.at) * 1000 || null,
    } : null,
    priced: [...weekBots].some((r) => num(r.costCents) > 0),
    at: now,
  }
}

// ── improvements ───────────────────────────────────────────────────────────────────

export const IMPROVEMENT_STATES = ['new', 'ask', 'accepted', 'done', 'rejected', 'stale']

/**
 * What the crew's audits found worth improving: a plain file, improvements.json in the crew folder, written
 * by the crew's own audit script. This only reads it, and answers the same list to the PC and the phone.
 * A decision is the owner's ('owner') or the lead bot's (any other name is the lead's); `lead` is the lead
 * bot's name, so the page can say who decided.
 */
export function improvementsView({ folder = crewFolder(), lead = '' } = {}) {
  const by = (who) => (who === 'owner' ? 'owner' : who ? 'lead' : '')
  const raw = readJson(path.join(folder, 'improvements.json'), [])
  const order = new Map(IMPROVEMENT_STATES.map((name, i) => [name, i]))
  const items = raw.filter((r) => r && typeof r === 'object' && r.title).map((r, i) => ({
    id: String(r.id || `IMP-${i + 1}`),
    title: cut(r.title, 200),
    path: cut(r.path, 200),
    evidence: cut(r.evidence, 600),
    fix: cut(r.fix, 400),
    who: cut(r.who, 60),
    status: order.has(r.status) ? r.status : 'new',
    job: cut(r.job, 40),
    added: Number(r.added) || 0,
    decidedBy: by(typeof r.decidedBy === 'string' ? r.decidedBy : ''),
    decidedAt: Number(r.decidedAt) || 0,
    reason: cut(r.reason, 600),
    history: (Array.isArray(r.history) ? r.history : []).filter((h) => h && typeof h.by === 'string' && h.by).slice(-10)
      .map((h) => ({ by: by(h.by), status: cut(h.status, 20), at: Number(h.at) || 0 })),
  })).sort((a, b) => order.get(a.status) - order.get(b.status) || b.added - a.added)
  const counts = Object.fromEntries(IMPROVEMENT_STATES.map((name) => [name, items.filter((i) => i.status === name).length]))
  return { items, counts, lead: cut(lead, 60) }
}

// ── what the owner can change ──────────────────────────────────────────────────────

const botPath = (botId) => {
  if (!ID.test(botId)) throw new EngineError(400, 'That is not a bot id')
  return `/agents/${botId}`
}

/** Starts a bot's next run in a fresh conversation: every saved session is dropped. */
export async function resetBotSession(botId, options) {
  await call(`${botPath(botId)}/runtime-state/reset-session`, { ...options, method: 'POST', body: {} })
  forgetReads()
  return { ok: true }
}

/** Puts a bot's settings back as they were after one revision. */
export async function rollbackBot(botId, revisionId, options) {
  if (!ID.test(revisionId || '')) throw new EngineError(400, 'That is not a revision id')
  await call(`${botPath(botId)}/config-revisions/${revisionId}/rollback`, { ...options, method: 'POST', body: {} })
  forgetReads()
  return { ok: true }
}

async function managedEntry(botId, options) {
  const bundle = await call(`${botPath(botId)}/instructions-bundle`, options)
  if (bundle.mode !== 'managed') throw new EngineError(409, 'These instructions cannot be changed in Botyard on this engine yet')
  return bundle.entryFile
}

/** Saves a bot's instructions as a new revision on top of the one the page read. */
export async function saveInstructions(botId, { content, baseRevisionId } = {}, options) {
  if (typeof content !== 'string' || !content.trim()) throw new EngineError(400, 'The instructions are empty')
  if (content.length > MAX_INSTRUCTIONS) throw new EngineError(400, 'The instructions are too long')
  if (baseRevisionId != null && !ID.test(baseRevisionId)) throw new EngineError(400, 'That is not a revision id')
  const entry = await managedEntry(botId, options)
  await call(`${botPath(botId)}/instructions-bundle/file`, { ...options, method: 'PUT', body: { path: entry, content, baseRevisionId: baseRevisionId ?? null } })
  forgetReads()
  return { ok: true }
}

/** The change one revision made against the one before it, as the engine's exact replacement diff. */
export async function instructionsDiff(botId, fromId, toId, options) {
  if (!ID.test(fromId || '') || !ID.test(toId || '')) throw new EngineError(400, 'That is not a revision id')
  const diff = await call(`${botPath(botId)}/instructions-bundle/diff?from=${fromId}&to=${toId}`, options)
  const clip = (s, keep) => (s.length > keep ? `…${s.slice(-keep)}` : s)
  return { before: clip(String(diff.prefix || ''), 300), removed: String(diff.removed || ''), added: String(diff.added || ''), after: String(diff.suffix || '').slice(0, 300) }
}

/** Makes an older revision the current one, as a new revision, so nothing is lost. */
export async function restoreInstructions(botId, { revisionId, baseRevisionId } = {}, options) {
  if (!ID.test(revisionId || '') || (baseRevisionId != null && !ID.test(baseRevisionId))) throw new EngineError(400, 'That is not a revision id')
  const entry = await managedEntry(botId, options)
  await call(`${botPath(botId)}/instructions-bundle/restore`, { ...options, method: 'POST', body: { path: entry, revisionId, baseRevisionId: baseRevisionId ?? null } })
  forgetReads()
  return { ok: true }
}
