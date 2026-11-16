/**
 * Botyard's engine, seen through its own API.
 *
 * The engine is a service with a public API, not a harness with a store, so "Botyard never
 * writes to a harness" is not in question here: nothing on disk is touched, and the only writes
 * are the ones a person asks for by name (add a job, comment on one, decide an approval, or say
 * something to a bot in chat).
 *
 * Everything here returns plain shapes the phone can render. The engine's own records carry
 * adapter configuration and paths, and none of that is passed on.
 */
/**
 * The engine's address: `BOTYARD_API_URL` when the service names it (with or without its `/api`),
 * else this computer on the engine's own port. One address; there is no second place to ask.
 */
export function engineBase(env = process.env) {
  const told = String(env.BOTYARD_API_URL || '').trim().replace(/\/+$/, '').replace(/\/api$/, '')
  return told || `http://127.0.0.1:${Number(env.BOTYARD_ENGINE_PORT) || 3210}`
}
const COMPANY = process.env.BOTYARD_ID || ''
// The engine's plain job list stops at 500, sorted by priority, so low-priority and older jobs fell off it
// (the research bot's, on 11 November, and about a hundred others). Every full read asks for all of them.
export const ALL_JOBS = 'limit=100000'
const TIME_LIMIT_MS = 10_000

import { guardFolder, readGuard } from './guard.mjs'
import { crewLooks, roleOf } from './looks.mjs'
import { OLD_CHOICES, PlanError, cronOf, planOf, wordsOf } from './timeplan.mjs'

export const MAX_TITLE = 200
export const MAX_TEXT = 8000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUNNING = new Set(['in_progress'])
const QUEUED = new Set(['backlog', 'todo'])
const FINISHED = new Set(['done', 'cancelled'])
const SHOWN_DONE = 10
const SHOWN_MESSAGES = 100
const SHOWN_UPDATES = 30
const PREVIEW_LOOKBACK = 5
const PREVIEW_CHARS = 140
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])
const FAILED_RUNS = new Set(['failed', 'timed_out'])
const SHOWN_RUNS = 50
const MAX_ANSWERS = 20
const REPORT_MS = 24 * 60 * 60 * 1000
// The engine's attention feed took about a second on 10 November, and it is the slowest part of the
// phone's first screen. The door keeps the last answer, so a refresh never waits longer than this.
const ATTENTION_TTL_MS = 20_000
const ATTENTION_WAIT_MS = 800
export const SCHEDULES = OLD_CHOICES
const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/
export const PROOF_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_PROOF_BYTES = 12 * 1024 * 1024

export class EngineError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * The crew: every bot of the company but the ones the owner retired. A retired bot keeps its history in
 * The engine and is shown nowhere here. A caller with its own fetcher (a test) names its retired bots itself.
 */
export async function crewOf(id, options) {
  const retired = new Set(options?.retired ?? (options?.fetcher ? [] : readGuard(guardFolder()).retired))
  const agents = await call(`/companies/${id}/agents`, options)
  return retired.size ? agents.filter((agent) => !retired.has(agent.name)) : agents
}

export async function call(path, { method = 'GET', body, fetcher = fetch } = {}) {
  let res
  const ask = (base) => fetcher(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIME_LIMIT_MS),
  })
  try {
    res = await ask(engineBase())
  } catch (err) {
    // Too slow is not the same as switched off, and the page should not say it is.
    if (err?.name === 'TimeoutError') throw new EngineError(504, `The crew's engine took longer than ${TIME_LIMIT_MS / 1000} seconds to answer. Try again`)
    throw new EngineError(503, 'The crew\'s engine is not running on this computer')
  }
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* a non-JSON error page */ }
  if (!res.ok) throw new EngineError(res.status, json?.error || `The crew's engine answered ${res.status}`)
  return json
}

/** For extras a screen can live without: losing one must not take the whole screen down. */
export const orElse = (promise, fallback) => promise.catch(() => fallback)

export async function companyId(options) {
  if (COMPANY) return COMPANY
  const companies = await call('/companies', options)
  const active = companies.find((c) => c.status === 'active') || companies[0]
  if (!active) throw new EngineError(404, 'This studio is not set up yet')
  return active.id
}

const botView = (agent, liveAgents, looks) => ({
  id: agent.id,
  name: agent.name,
  title: agent.title || '',
  status: liveAgents.has(agent.id) ? 'running' : agent.status,
  model: agent.adapterConfig?.model || '',
  spentCents: agent.spentMonthlyCents || 0,
  role: roleOf(agent),
  ...(looks?.get(agent.id) ? { look: looks.get(agent.id).look } : {}),
})

// The code each job is shown with, by its engine code, from every job this process has read.
const SHOWN = new Map()

/** A job's code as people read it: its project's letters and its number (`BAL-12`; `CREW-12` with no project). */
export function refOf(issue) {
  const own = issue?.identifier || ''
  const shown = issue?.displayIdentifier || own
  if (own) SHOWN.set(own, shown)
  return shown
}

/** A message with the engine's job codes in it turned into the codes people read. */
export const withRefs = (text) => String(text ?? '').replace(/\b[A-Z]{2,6}-\d+\b/g, (code) => SHOWN.get(code) || code)

/**
 * A job's title as the owner reads it. The crew titles jobs for each other ("Check LH-468: Signal box art:
 * fix invalid SVGs and typecheck"); the owner wants what was done, in plain words, without the
 * crew's bookkeeping: no job numbers, no round counters, no notes to the scripts.
 */
export function plainTitle(title = '') {
  let text = String(title).trim()
  const check = /^Check [A-Z]+-\d+( \([^)]{1,40}\))?:\s*/.test(text)
  text = text.replace(/^Check [A-Z]+-\d+( \([^)]{1,40}\))?:\s*/, '').replace(/^Ruling:\s*/, 'Decision: ')
  const fix = /^Fix \d+ of /.test(text)
  text = text.replace(/^Fix \d+ of /, '')
    .replace(/^[A-Z]{2,5}-\d+[:\s]+/, '')
    .replace(/\s*\((v\d+|restart|from main|redo|retry)\)\s*$/i, '')
    .replace(/\s+/g, ' ').trim()
  if (!text) return String(title).trim()
  text = text[0].toUpperCase() + text.slice(1)
  return check ? `Checked: ${text}` : fix ? `Fixed: ${text}` : text
}

/** Checks are the crew's own bookkeeping: a list of what got done names the work, not each check of it. */
const isCheck = (issue) => /^Check [A-Z]+-\d+/.test(issue.title || '')

const jobView = (issue, names, projects = new Map()) => ({
  id: issue.id,
  ref: refOf(issue, projects),
  engineRef: issue.identifier || '',
  title: plainTitle(withRefs(issue.title)),
  status: issue.status,
  bot: names.get(issue.assigneeAgentId) || '',
  project: projects.get(issue.projectId) || '',
  projectId: issue.projectId || '',
  priority: issue.priority || 'medium',
  updatedAt: issue.lastActivityAt || issue.updatedAt || issue.createdAt,
})

const attentionView = (item, kind) => ({
  kind,
  id: item.subject?.metadata?.issueId || '',
  title: withRefs(item.subject?.title || item.whyNow || 'Needs a look'),
  detail: withRefs(item.whyNow || ''),
})

function needsYou({ approvals, attention, issues, names, projects, failedRuns }) {
  const items = approvals.map((a) => ({
    kind: 'approval',
    id: a.id,
    title: a.payload?.title || a.payload?.name || a.type,
    detail: a.requestedByAgentId ? `Asked by ${names.get(a.requestedByAgentId) || 'a bot'}` : '',
  }))
  const noticed = (...kinds) => attention.filter((item) => kinds.includes(item.sourceKind))
  items.push(...noticed('issue_thread_interaction').map((item) => attentionView(item, 'question')))
  for (const issue of issues) {
    if (issue.status === 'blocked' || issue.status === 'in_review') {
      items.push({
        kind: issue.status === 'blocked' ? 'blocked' : 'review',
        id: issue.id,
        title: `${refOf(issue, projects)} ${withRefs(issue.title)}`.trim(),
        detail: names.get(issue.assigneeAgentId) || '',
      })
    }
  }
  const failures = noticed('failed_run', 'agent_error_alert')
  items.push(...failures.map((item) => attentionView(item, 'failed')))
  if (!failures.length && failedRuns > 0) {
    items.push({ kind: 'failed', id: '', title: `${failedRuns} failed run${failedRuns === 1 ? '' : 's'}`, detail: 'The Runs screen says why' })
  }
  return items
}

/** Tokens the bots used per provider. Subscription runs bill nothing, so dollars would always read zero. */
const usageView = (rows) => rows.map((row) => ({
  provider: row.provider,
  window: row.window,
  tokens: (row.inputTokens || 0) + (row.outputTokens || 0),
  cachedTokens: row.cachedInputTokens || 0,
}))

/** What happened in the last day, worked out from the jobs themselves with no AI. */
function dayReport({ issues, names, projects, spend, now = Date.now() }) {
  const since = now - REPORT_MS
  const finished = issues.filter((i) => i.status === 'done' && !isCheck(i) && Date.parse(i.completedAt || i.updatedAt || 0) >= since)
  return {
    finished: finished.slice(0, SHOWN_DONE).map((i) => ({ id: i.id, ref: refOf(i, projects), title: plainTitle(withRefs(i.title)), bot: names.get(i.assigneeAgentId) || '', project: projects.get(i.projectId) || '' })),
    finishedCount: finished.length,
    tokens: usageView(spend.filter((row) => row.window === '24h')),
  }
}

/**
 * Questions bots asked in their chats. The engine's attention feed leaves chats out, so without this a
 * choice the lead put to the owner never reached "Needs you". One card per chat; it opens the cards to answer.
 */
async function chatQuestions(id, names, options) {
  const chats = await orElse(call(`/companies/${id}/chats`, options), [])
  const asked = await Promise.all(chats.map(async (chat) => {
    const pending = (await orElse(call(`/issues/${chat.id}/interactions`, options), []))
      .filter((i) => i.status === 'pending').map(questionView).filter(Boolean)
    if (!pending.length) return null
    const bot = names.get(chat.conversationAgentId) || 'A bot'
    return {
      kind: 'question',
      id: chat.id,
      // Who asked: the answer is given in that bot's chat, where the question's choices are.
      botId: chat.conversationAgentId || '',
      title: pending.length === 1 ? pending[0].title : `${bot} has ${pending.length} questions for you`,
      detail: pending.length === 1 ? `${bot} asked in chat` : pending.map((q) => q.title).join('\n'),
      // Each question by its own id: the phone tells the owner once per question, whatever the card's words.
      asks: pending.map((q) => ({ id: q.id, title: q.title })),
    }
  }))
  return asked.filter(Boolean)
}

const attentionSeen = new WeakMap()
const attentionByCompany = new Map()
const waitUpTo = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * The engine's attention feed, answered from the last result while a fresh one is fetched behind
 * the request. The first call after a restart waits at most ATTENTION_WAIT_MS; every later one
 * inside the TTL is instant, and a slow feed never holds the phone's first screen.
 */
function attentionSoon(id, options) {
  // Keyed by the fetcher when a caller supplies one, so one door's tests cannot see another's
  // remembered feed; on the real door it is one company and one cache.
  const store = options?.fetcher ? attentionSeen : attentionByCompany
  const key = options?.fetcher || id
  const seen = store.get(key) || { at: 0, items: null, running: null }
  store.set(key, seen)
  const refresh = () => {
    if (seen.running) return seen.running
    seen.running = orElse(call(`/companies/${id}/attention`, options), { items: [] })
      .then((value) => {
        seen.at = Date.now()
        seen.items = value
      })
      .finally(() => {
        seen.running = null
      })
    return seen.running
  }
  if (seen.items && Date.now() - seen.at < ATTENTION_TTL_MS) return Promise.resolve(seen.items)
  const running = refresh()
  if (seen.items) return Promise.resolve(seen.items)
  return Promise.race([running, waitUpTo(ATTENTION_WAIT_MS)]).then(() => seen.items || { items: [] })
}

/** Everything the phone's first screen needs, in one call. */
export async function studioSummary(options) {
  const id = await companyId(options)
  const [company, agents, issues, approvals, dashboard, badges, live, projects, attention, spend] = await Promise.all([
    call(`/companies/${id}`, options),
    crewOf(id, options),
    call(`/companies/${id}/issues?${ALL_JOBS}`, options),
    call(`/companies/${id}/approvals?status=pending`, options),
    call(`/companies/${id}/dashboard`, options),
    call(`/companies/${id}/sidebar-badges`, options),
    call(`/companies/${id}/live-runs`, options),
    orElse(call(`/companies/${id}/projects`, options), []),
    attentionSoon(id, options),
    orElse(call(`/companies/${id}/costs/window-spend`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  for (const issue of issues) refOf(issue, projectNames)
  const asked = needsYou({ approvals, attention: attention?.items || [], issues, names, projects: projectNames, failedRuns: badges?.failedRuns || 0 })
  const inChats = (await chatQuestions(id, names, options)).filter((q) => !asked.some((a) => a.id === q.id))
  // Which project each one belongs to, where it is about a job: the map marks that project's bay.
  const projectOfJob = new Map(issues.map((i) => [i.id, projectNames.get(i.projectId) || '']))
  for (const need of [...asked, ...inChats]) need.project = projectOfJob.get(need.id) || ''
  const view = (issue) => jobView(issue, names, projectNames)
  const liveAgents = new Set(live.map((run) => run.agentId))
  const looks = crewLooks(agents)
  const byNewest = [...issues].sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')))
  return {
    company: company.name,
    bots: agents.map((a) => botView(a, liveAgents, looks)),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    needsYou: [...inChats, ...asked],
    running: byNewest.filter((i) => RUNNING.has(i.status)).map(view),
    queued: byNewest.filter((i) => QUEUED.has(i.status)).map(view),
    finished: byNewest.filter((i) => FINISHED.has(i.status) && !isCheck(i)).slice(0, SHOWN_DONE).map(view),
    usage: usageView(spend),
    report: dayReport({ issues, names, projects: projectNames, spend }),
    spentCents: dashboard?.costs?.monthSpendCents || 0,
    at: Date.now(),
  }
}

/**
 * The crew's own records as the engine keeps them, for the manager's view: who there is, every job,
 * the projects with their folders, and what is running now. Nothing here is shaped for a screen.
 */
export async function crewRecords(options) {
  const id = await companyId(options)
  const [company, agents, issues, projects, live, runs] = await Promise.all([
    orElse(call(`/companies/${id}`, options), null),
    crewOf(id, options),
    call(`/companies/${id}/issues?${ALL_JOBS}`, options),
    orElse(call(`/companies/${id}/projects`, options), []),
    orElse(call(`/companies/${id}/live-runs`, options), []),
    orElse(call(`/companies/${id}/heartbeat-runs?limit=${SHOWN_RUNS}&summary=true`, options), []),
  ])
  // An archived project is off the map and out of every list; its jobs keep their place in history.
  return { name: company?.name || '', agents, issues, projects: projects.filter((p) => !p.archivedAt), live, runs }
}

/** The newest comments on a job, newest first, as the engine gives them. */
export const jobComments = (jobId, count, options) => orElse(call(`/issues/${jobId}/comments?limit=${count}`, options), [])

/** The crew's scripts post with the owner's board identity and sign with this, so they are not shown as the owner. */
// A studio's own scripts may sign with their own prefix (`<!-- myshop-script: Night check -->`): the same rule.
const SCRIPT_MARK = /\n*<!-- [\w-]*script: ([^>]+?) -->\s*$/
// Messages the scripts posted before they signed them, known by their fixed wording.
const OLD_SCRIPT = [
  [/^The crew check found \d+ thing/, 'Crew check'],
  [/is stuck on .+ Read its comments and act now/s, 'Review guard'],
  [/ is finished\. Critic's verdict:/, 'Review guard'],
  [/You own every session: check it with sessions\.py list/, 'Review guard'],
]
const scriptOf = (body = '') => body.match(SCRIPT_MARK)?.[1] || OLD_SCRIPT.find(([rx]) => rx.test(body))?.[1]

/** Who wrote a comment, as the phone should show it. */
function authorOf(comment, names) {
  if (comment.authorType === 'system') return 'Botyard'
  const script = comment.authorType === 'user' && scriptOf(comment.body)
  if (script) return script
  return comment.authorAgentId ? names.get(comment.authorAgentId) || 'A bot' : 'You'
}

/** A note from Botyard or one of the crew's scripts: shown as a note, not as the bot's words or the owner's. */
const noteOf = (comment) => comment.authorType === 'system' || Boolean(comment.authorType === 'user' && scriptOf(comment.body))
/** Whether the owner wrote it, and its words without a script's signature. */
const mineOf = (comment) => comment.authorType === 'user' && !scriptOf(comment.body)
const textOf = (comment) => withRefs((comment.body || '').replace(SCRIPT_MARK, ''))

/** A question a bot is waiting on, in the two forms the app can answer. Other kinds stay in the engine. */
/** A question with nothing to pick from: the owner answers it in their own words. */
const OWN_WORDS = Object.freeze({ id: 'answer', prompt: '', multiple: false, required: true, options: [] })

export function questionView(interaction) {
  const { id, kind, title, payload } = interaction
  if (kind === 'ask_user_questions') {
    const asked = payload?.questions || []
    return {
      id,
      kind: 'choice',
      title: title || payload?.title || 'A bot has a question',
      // A bot can ask without giving any choice; the card must still have somewhere to answer.
      items: !asked.length ? [{ ...OWN_WORDS }] : asked.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        multiple: q.selectionMode === 'multi',
        required: Boolean(q.required),
        options: (q.options || []).filter((o) => !o.freeText).map((o) => ({ id: o.id, label: o.label, hint: o.description || '' })),
      })),
    }
  }
  if (kind === 'request_confirmation') {
    return {
      id,
      kind: 'confirm',
      title: title || 'A bot wants a yes or no',
      prompt: payload?.prompt || '',
      accept: payload?.acceptLabel || 'Yes',
      reject: payload?.rejectLabel || 'No',
    }
  }
  return null
}

/** What the owner chose on an answered card, in the words of its options. */
function answerOf(interaction) {
  const { payload, result } = interaction
  if (result?.summaryMarkdown) return result.summaryMarkdown
  if (interaction.kind === 'request_confirmation') return interaction.status === 'accepted' ? payload?.acceptLabel || 'Yes' : payload?.rejectLabel || 'No'
  const questions = new Map((payload?.questions || []).map((q) => [q.id, q]))
  return (result?.answers || []).flatMap((answer) => {
    const options = new Map((questions.get(answer.questionId)?.options || []).filter((o) => !o.freeText).map((o) => [o.id, o.label]))
    return [...(answer.optionIds || []).map((id) => options.get(id)), answer.otherText].filter(Boolean)
  }).join(', ')
}

/**
 * A card a bot put in a conversation: a question, a yes or no, or a service it wants connected.
 * The chat shows every one where it was asked, so "I've put a card in your chat" is never a card
 * nobody can find. A kind the app cannot act on still shows, with the engine as the place to do it.
 */
function cardView(interaction, chat) {
  const { id, kind, status, title, summary, payload, result } = interaction
  const state = status === 'pending' ? 'pending' : ['cancelled', 'expired', 'superseded'].includes(status) || result?.outcome === 'withdrawn' ? 'cancelled' : 'done'
  const base = { id, at: interaction.createdAt, state }
  const question = questionView(interaction)
  if (question) {
    return {
      ...base, kind: question.kind, title: question.title,
      ...(state === 'pending' ? { question } : { detail: state === 'done' ? answerOf(interaction) : result?.reason || '' }),
    }
  }
  const service = payload?.serviceName || ''
  return {
    ...base,
    kind: kind === 'connection_intent' ? 'connect' : 'other',
    title: title || (service ? `Connect ${service}` : 'A bot needs something from you'),
    detail: summary || '',
    // Signing in to a service is done in Botyard, on the Connectors page; the card is then settled here.
    service,
  }
}

/** The latest run on this job: whether it is live, and why it failed if it did. */
function runView(runs, live, names) {
  const latest = live[0] || runs.find((r) => r.issueId)
  if (!latest) return null
  const failed = !live.length && FAILED_RUNS.has(latest.status)
  return {
    id: latest.id,
    live: live.length > 0,
    status: latest.status,
    bot: names.get(latest.agentId) || '',
    why: failed ? latest.error || latest.errorCode || 'The run stopped without saying why' : '',
    at: latest.finishedAt || latest.startedAt || latest.createdAt || '',
  }
}

export async function jobDetail(jobId, options) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  const [issue, comments, interactions, live, attachments] = await Promise.all([
    call(`/issues/${jobId}`, options),
    // Newest first. The lead's chat once sent 600 updates (550 KB) every 20 seconds, and the phone was too busy
    // drawing them to take a tap on a question card.
    call(`/issues/${jobId}/comments?limit=${SHOWN_UPDATES}`, options),
    orElse(call(`/issues/${jobId}/interactions`, options), []),
    orElse(call(`/issues/${jobId}/live-runs`, options), []),
    orElse(call(`/issues/${jobId}/attachments`, options), []),
  ])
  const [agents, runs, projects] = await Promise.all([
    crewOf(issue.companyId, options),
    orElse(call(`/companies/${issue.companyId}/heartbeat-runs?limit=${SHOWN_RUNS}&summary=true`, options), []),
    orElse(call(`/companies/${issue.companyId}/projects`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  return {
    ...jobView(issue, names, new Map(projects.map((p) => [p.id, p.name]))),
    description: issue.description || '',
    run: runView(runs.filter((r) => r.issueId === jobId), live, names),
    questions: interactions.filter((i) => i.status === 'pending').map(questionView).filter(Boolean),
    proof: attachments.filter((a) => PROOF_TYPES.has(a.contentType)).map((a) => ({ id: a.id, name: a.originalFilename || 'Screenshot' })),
    comments: comments.map((c) => ({
      id: c.id,
      from: authorOf(c, names),
      text: textOf(c),
      at: c.createdAt,
    })),
  }
}

/** The newest thing a person or a bot said, for the chat list. System notes do not count. */
async function lastSaid(chat, options) {
  if (!chat) return null
  const comments = await call(`/issues/${chat.id}/comments?limit=${PREVIEW_LOOKBACK}`, options)
  const said = comments.find((c) => c.authorType !== 'system')
  return said ? { text: textOf(said).slice(0, PREVIEW_CHARS), mine: mineOf(said), at: said.createdAt } : null
}

/** Everyone you can talk to, with whether a conversation has started. */
export async function chatList(options) {
  const id = await companyId(options)
  const [agents, chats, live] = await Promise.all([
    crewOf(id, options),
    call(`/companies/${id}/chats`, options),
    call(`/companies/${id}/live-runs`, options),
  ])
  const liveAgents = new Set(live.map((run) => run.agentId))
  const started = new Map(chats.map((chat) => [chat.conversationAgentId, chat]))
  return Promise.all(agents.map(async (agent) => {
    const chat = started.get(agent.id)
    return {
      ...botView(agent, liveAgents, crewLooks(agents)),
      lastActiveAt: chat?.lastActivityAt || chat?.updatedAt || null,
      lastMessage: await lastSaid(chat, options),
    }
  }))
}

/** One conversation, oldest message first. A bot nobody has spoken to yet has an empty one. */
export async function chatThread(botId, options) {
  if (!ID.test(botId)) throw new EngineError(400, 'That is not a bot id')
  const id = await companyId(options)
  const [agent, chat] = await Promise.all([
    call(`/agents/${botId}`, options),
    call(`/companies/${id}/chats/${botId}`, options),
  ])
  const bot = { id: agent.id, name: agent.name, title: agent.title || '' }
  if (!chat) return { bot, working: false, messages: [], cards: [] }
  const [comments, interactions, live] = await Promise.all([
    call(`/issues/${chat.id}/comments?limit=${SHOWN_MESSAGES}`, options),
    orElse(call(`/issues/${chat.id}/interactions`, options), []),
    orElse(call(`/issues/${chat.id}/live-runs`, options), []),
  ])
  const names = new Map([[agent.id, agent.name]])
  const messages = comments
    .map((c) => ({ id: c.id, from: authorOf(c, names), mine: mineOf(c), note: noteOf(c), text: textOf(c), at: c.createdAt }))
    .reverse()
  // Settled cards only as far back as the messages go; one still waiting always shows.
  const since = messages.length ? Date.parse(messages[0].at) : 0
  return {
    bot,
    /** The conversation's own id: a card is answered against it. */
    chatId: chat.id,
    // Working while a run of the bot is going on this chat: the engine's own conversation state stays
    // "open" or "waiting" through a run, so the phone never showed the bot typing.
    working: chat.conversationState === 'active' || live.some((run) => run.agentId === agent.id && ['queued', 'running'].includes(run.status)),
    messages,
    cards: interactions
      .filter((i) => i.status === 'pending' || Date.parse(i.createdAt) >= since)
      .map((i) => cardView(i, chat))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  }
}

/**
 * Say something to a bot. `requestId` comes from the phone, so a retry after a dropped connection
 * cannot send the same message twice.
 */
export async function sendChat(botId, text, requestId, options) {
  if (!ID.test(botId)) throw new EngineError(400, 'That is not a bot id')
  if (!ID.test(requestId || '')) throw new EngineError(400, 'A message needs a request id')
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) throw new EngineError(400, 'Write a message first')
  if (body.length > MAX_TEXT) throw new EngineError(400, `Messages are limited to ${MAX_TEXT} characters`)
  const id = await companyId(options)
  const chat = await call(`/companies/${id}/chats/${botId}`, { ...options, method: 'POST', body: {} })
  const comment = await call(`/issues/${chat.id}/comments`, { ...options, method: 'POST', body: { body, clientRequestId: requestId } })
  return { id: comment.id }
}

/** A new job goes to the top of the org chart, which decides who does it, unless a bot is named. */
export async function addJob({ title, description = '', projectId, botId, priority = 'medium' } = {}, options) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new EngineError(400, 'A job needs a title')
  if (name.length > MAX_TITLE) throw new EngineError(400, `Job titles are limited to ${MAX_TITLE} characters`)
  if (typeof description !== 'string' || description.length > MAX_TEXT) {
    throw new EngineError(400, `Job details are limited to ${MAX_TEXT} characters`)
  }
  if (!PRIORITIES.has(priority)) throw new EngineError(400, 'Priority must be critical, high, medium or low')
  const id = await companyId(options)
  const [agents, projects] = await Promise.all([
    crewOf(id, options),
    projectId ? call(`/companies/${id}/projects`, options) : [],
  ])
  const owner = botId ? agents.find((a) => a.id === botId) : agents.find((a) => a.role === 'ceo')
  if (!owner) throw botId ? new EngineError(400, 'That bot is not in this studio') : new EngineError(409, 'No bot leads the crew yet. Pick who does this job, or add a bot first')
  if (projectId && !projects.some((p) => p.id === projectId)) throw new EngineError(400, 'That project is not in this studio')
  const issue = await call(`/companies/${id}/issues`, {
    ...options,
    method: 'POST',
    body: { title: name, description: description.trim(), status: 'todo', priority, assigneeAgentId: owner.id, ...(projectId ? { projectId } : {}) },
  })
  return { id: issue.id, ref: issue.identifier || '' }
}

export async function addComment(jobId, text, options) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) throw new EngineError(400, 'Write a comment first')
  if (body.length > MAX_TEXT) throw new EngineError(400, `Comments are limited to ${MAX_TEXT} characters`)
  const comment = await call(`/issues/${jobId}/comments`, { ...options, method: 'POST', body: { body } })
  return { id: comment.id }
}

export async function decideApproval(approvalId, decision, note, options) {
  if (!ID.test(approvalId)) throw new EngineError(400, 'That is not an approval id')
  if (decision !== 'approve' && decision !== 'reject') throw new EngineError(400, 'Choose approve or reject')
  const decisionNote = typeof note === 'string' ? note.trim().slice(0, MAX_TEXT) : ''
  await call(`/approvals/${approvalId}/${decision}`, { ...options, method: 'POST', body: decisionNote ? { decisionNote } : {} })
  return { ok: true }
}

/** Where a job's work lives, from the engine's own record. Null when it never had a workspace. */
export async function jobWorkspace(jobId, options) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  const issue = await call(`/issues/${jobId}`, options)
  if (!issue.executionWorkspaceId) return null
  const workspace = await orElse(call(`/execution-workspaces/${issue.executionWorkspaceId}`, options), null)
  return workspace && { cwd: workspace.cwd, branch: workspace.branchName, base: workspace.baseRef }
}

/** One screenshot's bytes. Only plain image types pass, so nothing a browser would run can come through here. */
export async function proofImage(attachmentId, { fetcher = fetch } = {}) {
  if (!ID.test(attachmentId)) throw new EngineError(400, 'That is not an image id')
  let res
  try {
    res = await fetcher(`${engineBase()}/api/attachments/${attachmentId}/content`, { method: 'GET', signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  } catch {
    throw new EngineError(503, 'The crew\'s engine is not running on this computer')
  }
  if (!res.ok) throw new EngineError(res.status, `The crew's engine answered ${res.status}`)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!PROOF_TYPES.has(type)) throw new EngineError(415, 'That file is not an image')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_PROOF_BYTES) throw new EngineError(413, 'That image is too large')
  return { type, bytes }
}

/**
 * Any file attached to a job, for the map's job page and library. Images keep their type; text is
 * served as plain text; everything else only as a download, so nothing a bot attached can run in
 * the map's page.
 */
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])
export async function attachmentFile(attachmentId, { fetcher = fetch } = {}) {
  if (!ID.test(attachmentId)) throw new EngineError(400, 'That is not a file id')
  let res
  try {
    res = await fetcher(`${engineBase()}/api/attachments/${attachmentId}/content`, { method: 'GET', signal: AbortSignal.timeout(TIME_LIMIT_MS) })
  } catch {
    throw new EngineError(503, 'The crew\'s engine is not running on this computer')
  }
  if (!res.ok) throw new EngineError(res.status, `The crew's engine answered ${res.status}`)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_PROOF_BYTES) throw new EngineError(413, 'That file is too large to show')
  const shown = PROOF_TYPES.has(type) ? type : TEXT_TYPES.has(type) ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  return { type: shown, bytes, download: shown === 'application/octet-stream' }
}

/** File kinds the owner may attach to a job from the map, by type. */
export const ATTACH_TYPES = new Set([...PROOF_TYPES, 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/zip'])
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024

/** Attach a file to a job, as the engine's own upload form does. */
export async function uploadAttachment(jobId, { name, type, bytes } = {}, { fetcher = fetch, ...options } = {}) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  const file = String(name || '').replace(/[\\/\0]/g, '').trim().slice(0, 160)
  if (!file) throw new EngineError(400, 'The file needs a name')
  if (!ATTACH_TYPES.has(type)) throw new EngineError(415, 'Attach an image, a PDF, a text, CSV, JSON or zip file')
  if (!bytes?.length) throw new EngineError(400, 'The file is empty')
  if (bytes.length > MAX_ATTACH_BYTES) throw new EngineError(413, 'Files are limited to 10 MB')
  const id = await companyId({ fetcher, ...options })
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), file)
  let res
  try {
    res = await fetcher(`${engineBase()}/api/companies/${id}/issues/${jobId}/attachments`, { method: 'POST', body: form, signal: AbortSignal.timeout(TIME_LIMIT_MS * 3) })
  } catch {
    throw new EngineError(503, 'The crew\'s engine is not running on this computer')
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new EngineError(res.status, json?.error || `The crew's engine answered ${res.status}`)
  return { id: json?.id || '', name: file }
}

const routineView = (routine, names, projects) => {
  const schedule = (routine.triggers || []).find((t) => t.kind === 'schedule' && !t.archived)
  return {
    id: routine.id,
    title: routine.title,
    paused: routine.status !== 'active',
    bot: names.get(routine.assigneeAgentId) || '',
    project: projects.get(routine.projectId) || '',
    cron: schedule?.cronExpression || '',
    when: wordsOf(schedule?.cronExpression),
    plan: planOf(schedule?.cronExpression),
    nextAt: schedule?.nextRunAt || null,
    lastAt: routine.lastTriggeredAt || routine.lastRun?.triggeredAt || null,
    lastStatus: routine.lastRun?.status || '',
  }
}

export async function routineList(options) {
  const id = await companyId(options)
  const [routines, agents, projects] = await Promise.all([
    call(`/companies/${id}/routines`, options),
    crewOf(id, options),
    orElse(call(`/companies/${id}/projects`, options), []),
  ])
  const names = new Map(agents.map((a) => [a.id, a.name]))
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  return routines.filter((r) => r.status !== 'archived').map((r) => routineView(r, names, projectNames))
}

/** The timetable for what a page sent: a plan (see timeplan.mjs), or one of the four old choices by name. */
export function timetableOf({ plan, schedule } = {}) {
  try { return cronOf(plan ?? schedule) } catch (err) {
    if (err instanceof PlanError) throw new EngineError(400, err.message)
    throw err
  }
}

/** A repeating job. When it runs is a plain choice (every so often, a time of day), never a line the owner must write. */
export async function addRoutine({ title, description = '', botId, projectId, schedule, plan, timezone = 'UTC' } = {}, options) {
  const name = typeof title === 'string' ? title.trim() : ''
  if (!name) throw new EngineError(400, 'A routine needs a title')
  if (name.length > MAX_TITLE) throw new EngineError(400, `Titles are limited to ${MAX_TITLE} characters`)
  if (typeof description !== 'string' || description.length > MAX_TEXT) throw new EngineError(400, `Details are limited to ${MAX_TEXT} characters`)
  const cronExpression = timetableOf({ plan, schedule })
  if (typeof timezone !== 'string' || !TIMEZONE.test(timezone)) throw new EngineError(400, 'That is not a time zone')
  const id = await companyId(options)
  const [agents, projects] = await Promise.all([crewOf(id, options), projectId ? call(`/companies/${id}/projects`, options) : []])
  const owner = botId ? agents.find((a) => a.id === botId) : agents.find((a) => a.role === 'ceo') || agents[0]
  if (!owner) throw new EngineError(400, botId ? 'That bot is not in this studio' : 'Add a bot first: a routine needs someone to do it')
  if (projectId && !projects.some((p) => p.id === projectId)) throw new EngineError(400, 'That project is not in this studio')
  const routine = await call(`/companies/${id}/routines`, {
    ...options,
    method: 'POST',
    body: { title: name, description: description.trim(), assigneeAgentId: owner.id, ...(projectId ? { projectId } : {}) },
  })
  await call(`/routines/${routine.id}/triggers`, { ...options, method: 'POST', body: { kind: 'schedule', cronExpression, timezone } })
  return { id: routine.id }
}

/** Change what a routine is: its title, details, who does it, its project. Only what the page sent changes. */
export async function editRoutine(routineId, changes = {}, options) {
  if (!ID.test(routineId || '')) throw new EngineError(400, 'That is not a routine id')
  const body = {}
  if (changes.title !== undefined) {
    const title = typeof changes.title === 'string' ? changes.title.trim() : ''
    if (!title) throw new EngineError(400, 'A routine needs a title')
    if (title.length > MAX_TITLE) throw new EngineError(400, `Titles are limited to ${MAX_TITLE} characters`)
    body.title = title
  }
  if (changes.description !== undefined) {
    if (typeof changes.description !== 'string' || changes.description.length > MAX_TEXT) throw new EngineError(400, `Details are limited to ${MAX_TEXT} characters`)
    body.description = changes.description.trim()
  }
  if (changes.botId !== undefined || changes.projectId !== undefined) {
    const id = await companyId(options)
    if (changes.botId !== undefined) {
      if (!(await crewOf(id, options)).some((a) => a.id === changes.botId)) throw new EngineError(400, 'That bot is not in this studio')
      body.assigneeAgentId = changes.botId
    }
    if (changes.projectId !== undefined) {
      if (changes.projectId && !(await call(`/companies/${id}/projects`, options)).some((p) => p.id === changes.projectId)) throw new EngineError(400, 'That project is not in this studio')
      body.projectId = changes.projectId || null
    }
  }
  if (!Object.keys(body).length) throw new EngineError(400, 'Nothing to change')
  await call(`/routines/${routineId}`, { ...options, method: 'PATCH', body })
  return { ok: true, changed: Object.keys(body) }
}

async function setRoutineStatus(routineId, status, options) {
  if (!ID.test(routineId)) throw new EngineError(400, 'That is not a routine id')
  await call(`/routines/${routineId}`, { ...options, method: 'PATCH', body: { status } })
  return { ok: true }
}

export const pauseRoutine = (id, options) => setRoutineStatus(id, 'paused', options)
export const resumeRoutine = (id, options) => setRoutineStatus(id, 'active', options)
export const removeRoutine = (id, options) => setRoutineStatus(id, 'archived', options)

export async function runRoutine(routineId, options) {
  if (!ID.test(routineId)) throw new EngineError(400, 'That is not a routine id')
  await call(`/routines/${routineId}/run`, { ...options, method: 'POST', body: {} })
  return { ok: true }
}

/** Stops whatever is running on a job now. The job stays open, so a comment can start it again. */
export async function stopJob(jobId, options) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  const live = await call(`/issues/${jobId}/live-runs`, options)
  await Promise.all(live.map((run) => call(`/heartbeat-runs/${run.id}/cancel`, { ...options, method: 'POST', body: {} })))
  return { stopped: live.length }
}

async function setJobStatus(jobId, status, options) {
  if (!ID.test(jobId)) throw new EngineError(400, 'That is not a job id')
  await call(`/issues/${jobId}`, { ...options, method: 'PATCH', body: { status } })
  return { ok: true }
}

export const cancelJob = (jobId, options) => setJobStatus(jobId, 'cancelled', options)
export const reopenJob = (jobId, options) => setJobStatus(jobId, 'todo', options)

async function setBotRunning(botId, action, options) {
  if (!ID.test(botId)) throw new EngineError(400, 'That is not a bot id')
  await call(`/agents/${botId}/${action}`, { ...options, method: 'POST', body: {} })
  return { ok: true }
}

export const pauseBot = (botId, options) => setBotRunning(botId, 'pause', options)
export const resumeBot = (botId, options) => setBotRunning(botId, 'resume', options)

function questionPath(jobId, questionId, verb) {
  if (!ID.test(jobId) || !ID.test(questionId)) throw new EngineError(400, 'That is not a question id')
  return `/issues/${jobId}/interactions/${questionId}/${verb}`
}

const answerView = (answer) => ({
  questionId: String(answer?.questionId || ''),
  optionIds: Array.isArray(answer?.optionIds) ? answer.optionIds.map(String) : [],
  ...(typeof answer?.otherText === 'string' ? { otherText: answer.otherText.slice(0, MAX_TEXT) } : {}),
})

export async function answerQuestion(jobId, questionId, answers, options) {
  if (!Array.isArray(answers) || !answers.length || answers.length > MAX_ANSWERS) throw new EngineError(400, 'Answer the question first')
  await call(questionPath(jobId, questionId, 'respond'), { ...options, method: 'POST', body: { answers: answers.map(answerView) } })
  return { ok: true }
}

export async function acceptQuestion(jobId, questionId, options) {
  await call(questionPath(jobId, questionId, 'accept'), { ...options, method: 'POST', body: {} })
  return { ok: true }
}

export async function rejectQuestion(jobId, questionId, reason, options) {
  const note = typeof reason === 'string' ? reason.trim().slice(0, MAX_TEXT) : ''
  await call(questionPath(jobId, questionId, 'reject'), { ...options, method: 'POST', body: note ? { reason: note } : {} })
  return { ok: true }
}

/**
 * A bot's request for a service, settled from Botyard. Services are connected on Botyard's Connectors
 * page, not in the engine, so the engine's own card is closed with the outcome as its reason: that
 * reason is what the bot reads when it is woken.
 */
export async function settleConnectCard(cardId, { connected = false, service = '' } = {}, options) {
  const name = String(service || 'the service').slice(0, 80)
  const reason = connected
    ? `The owner connected ${name} in Botyard. From your next run its tools are among yours, named after the service (mcp__<service>__...). Do not ask the connections tool for it again; if a tool you need is refused, ask the owner on a card.`
    : `The owner said no to connecting ${name}. Carry on without it and say so in your report.`
  await call(`/connection-intents/${encodeURIComponent(cardId)}/decline`, { ...options, method: 'POST', body: { reason } })
  return { ok: true }
}

/** Each bot with the model it runs on now, and nothing else of its configuration. */
export async function agentModels(options) {
  const id = await companyId(options)
  const agents = await crewOf(id, options)
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    model: typeof agent.adapterConfig?.model === 'string' ? agent.adapterConfig.model : '',
    adapter: typeof agent.adapterType === 'string' ? agent.adapterType : '',
  }))
}
