/**
 * The crew flow: who leads, who answers to whom, what each bot is on, and every message that went
 * between them, read from what the engine already keeps. It is what the crew map draws.
 *
 *   GET /api/studio/flow?window=now|24h|7d
 *
 * Nodes are the owner, every bot of the crew, and the scripts that wrote to the crew (a machine room).
 * Edges are typed and directed, and each kind comes from the bots' roles and the jobs' fields, never
 * from a bot's name, so any yard reads the same way:
 *
 *   order     the owner to a bot: a job the owner made, the owner's word in a chat or on a job
 *   brief     a bot to another bot: a job one made for the other, or a word on that job after
 *   report    a bot back to whoever asked: its words on a job it was given, or in its chat with the owner
 *   check     a request to check a piece of work (a job titled "Check <code>: ...")
 *   verdict   a checker's or reviewer's PASS, FAIL, MET or NOT MET, back to whoever asked
 *   ask       a ruling question, to a bot whose role is ruler (or a job titled "Ruling: ...")
 *   ruling    the ruler's answer, back to whoever asked
 *   idea      work a researcher put to the crew
 *   approval  the ruler's yes on a researcher's idea
 *   start     a job the lead made from an idea (its parent is the idea's job)
 *   card      a bot's card that waits for the owner's answer
 *   notice    a script's note to a bot (an author `script:<name>`, or a signed note)
 *   wait      dashed: a bot waits on another bot's job, or on the owner's card
 *
 * Pure in its middle (`buildFlow`), so a test can feed it a studio; read through `crewFlow`, which keeps
 * the answer ten seconds and works it out again as soon as a job, a comment or a card changes.
 */
import { guardFolder, readGuard } from './guard.mjs'
import { crewLooks, roleOf } from './looks.mjs'
import { copyGroups, foldKeys, runningCopy } from './copies.mjs'
import { crewFolder, modelLabel } from './models.mjs'
import { readCrewFiles, kindOf, workName } from './manager.mjs'
import { readRested } from './crew.mjs'
import { waitingCount } from './cards.mjs'
import { call, companyId, crewOf, orElse, plainTitle, refOf, withRefs } from './engine.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY
export const WINDOWS = { now: HOUR, '24h': DAY, '7d': WEEK }
const FLOW_TTL_MS = 10_000
const SHOWN_MESSAGES = 5
const SHOWN_TITLE = 64
const SHOWN_TEXT = 160
const COMMENTS_PER_JOB = 30
const MOST_JOBS = 500
const AT_ONCE = 8

/** Every kind of line, in the legend's order, with its words. The page draws each in its own colour and mark. */
export const EDGE_KINDS = [
  { kind: 'order', label: 'Order', says: 'The owner to a bot' },
  { kind: 'brief', label: 'Brief', says: 'A job handed to a bot' },
  { kind: 'report', label: 'Report', says: 'Back to whoever asked' },
  { kind: 'check', label: 'Check', says: 'Asked to check a piece of work' },
  { kind: 'verdict', label: 'Verdict', says: 'Pass or fail, met or not met' },
  { kind: 'ask', label: 'Ruling asked', says: 'A hard call put to the ruler' },
  { kind: 'ruling', label: 'Ruling', says: "The ruler's answer" },
  { kind: 'idea', label: 'Idea', says: 'Work a researcher put forward' },
  { kind: 'approval', label: 'Approved', says: "The ruler's yes on an idea" },
  { kind: 'start', label: 'Start', says: 'Work started from an idea' },
  { kind: 'card', label: 'Card', says: 'A bot waits for your answer' },
  { kind: 'notice', label: 'Notice', says: 'A script told a bot' },
  { kind: 'wait', label: 'Waiting on', says: 'Cannot go on until the other side moves' },
]
const KINDS = new Set(EDGE_KINDS.map((k) => k.kind))

/** A role, in the words a chart prints. */
export const ROLE_NAMES = { lead: 'Lead', ruler: 'Ruler', reviewer: 'Reviewer', builder: 'Builder', checker: 'Checker', researcher: 'Researcher', general: 'Crew' }
const OPEN = new Set(['in_progress', 'todo', 'backlog', 'blocked', 'in_review'])
const FAILED_RUNS = new Set(['failed', 'timed_out'])
const ENGINE = { claude_local: 'Claude', codex_local: 'Codex', gemini_local: 'Antigravity', opencode_local: 'Free model' }

const stamp = (v) => (v ? Date.parse(v) || 0 : 0)
const touched = (i) => stamp(i.lastActivityAt || i.updatedAt || i.createdAt)
const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const firstLine = (body = '') => short(withRefs(String(body).replace(/<!--[\s\S]*?-->/g, '').replace(/`/g, '').replace(/[#*_>]+/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) || '').replace(/\s+/g, ' '), SHOWN_TEXT)

/** A script's own signature at the end of a note it posted with the owner's board identity. */
const SCRIPT_MARK = /<!-- [\w-]*script: ([^>]+?) -->\s*$/
/** Who wrote a comment: a bot by id, a script by name, or the owner. */
export function authorOf(comment = {}) {
  const user = String(comment.authorUserId || '')
  if (user.startsWith('script:')) return { script: user.slice(7) || 'script' }
  if (comment.authorType === 'script') return { script: String(comment.authorName || comment.authorScript || 'script') }
  if (comment.authorType === 'agent' && comment.authorAgentId) return { agent: comment.authorAgentId }
  if (comment.authorType === 'system') return { script: 'Botyard' }
  const signed = SCRIPT_MARK.exec(comment.body || '')?.[1]
  if (signed) return { script: signed.trim() }
  return { owner: true }
}

/** The result a comment states, if it states one: MET, NOT MET, PASS, FAIL, BLOCK. Null when it says none. */
export function outcomeOf(body = '') {
  const named = /(?:OUTCOME|VERDICT|RESULT)\W{1,6}(NOT MET|MET|PASS(?:ED)?|FAIL(?:ED)?|BLOCK(?:ING|ED)?)/i.exec(body)
  if (!named) return null
  return /^(MET|PASS)/i.test(named[1]) ? 'met' : 'not met'
}
/** A ruler's yes on an idea. */
const approves = (body = '') => /\b(APPROVED|GO)\b/.test(body) || outcomeOf(body) === 'met'

/** A node's id for a script: one machine-room node per name. */
const scriptId = (name) => `script:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script'}`

/**
 * The flow from records in hand. `comments` is a map of job id to its comments (any order); `needs` is the
 * "Needs you" list with each card's state; `blockers` a map of job id to the jobs it waits on.
 */
export function buildFlow(input) {
  const fold = copyGroups(input.agents || [])
  if (!fold.parentOf.size) return flowOf(input, new Map())
  // A bot's copies on other AIs are that bot: every id is put as its parent's before the flow is made, so
  // the map has one node, one set of lines and one count for it. The copy it runs on now is told apart.
  const to = (list, keys) => foldKeys(list, keys, fold)
  const sums = new Map()
  for (const row of input.costs?.week || []) {
    const id = fold.idOf(row.agentId)
    const sum = sums.get(id) || { ...row, agentId: id, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens']) sum[key] = Number(sum[key] || 0) + Number(row[key] || 0)
    sums.set(id, sum)
  }
  const liveIds = new Set((input.live || []).map((r) => r.agentId))
  const heldIds = new Set((input.issues || []).filter((i) => i.status === 'in_progress' && i.assigneeAgentId).map((i) => i.assigneeAgentId))
  const on = new Map(fold.top.filter((a) => fold.copiesOf.has(a.id)).map((a) => [a.id, { agent: runningCopy(a, fold, { liveIds, heldIds }), copies: fold.family(a) }]))
  return flowOf({
    ...input,
    agents: fold.top,
    issues: to(input.issues, ['assigneeAgentId', 'createdByAgentId', 'conversationAgentId']),
    chats: to(input.chats, ['assigneeAgentId', 'createdByAgentId', 'conversationAgentId']),
    live: to(input.live, ['agentId']),
    runs: to(input.runs, ['agentId']),
    comments: new Map([...(input.comments || new Map())].map(([id, list]) => [id, to(list, ['authorAgentId'])])),
    needs: to(input.needs, ['botId']),
    blockers: new Map([...(input.blockers || new Map())].map(([id, list]) => [id, to(list, ['assigneeAgentId'])])),
    costs: { ...(input.costs || {}), week: [...sums.values()] },
  }, on)
}

function flowOf({ agents = [], issues: jobs = [], chats = [], projects = [], live = [], runs = [], comments = new Map(), needs = [], blockers = new Map(), costs = { week: [], weekStart: 0 }, guard = {}, rested = {}, window = '24h', now = Date.now() }, copyOn) {
  const span = WINDOWS[window] ? window : '24h'
  // A chat with a bot is a job of its own in the engine, listed apart from the work.
  const known = new Set(jobs.map((i) => i.id))
  const issues = [...jobs, ...chats.filter((c) => !known.has(c.id)).map((c) => ({ ...c, conversationAgentId: c.conversationAgentId || c.assigneeAgentId }))]
  const since = now - WINDOWS[span]
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))
  for (const issue of issues) refOf(issue, projectNames)
  const looks = crewLooks(agents)
  const role = (id) => looks.get(id)?.role || 'general'
  const bots = new Map(agents.map((a) => [a.id, a]))
  const byId = new Map(issues.map((i) => [i.id, i]))
  const byRef = new Map(issues.map((i) => [i.identifier, i]))
  const lead = agents.filter((a) => role(a.id) === 'lead').sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0] || null
  const liveBots = new Set(live.map((r) => r.agentId))
  const liveJobs = new Set(live.map((r) => r.issueId || r.jobId).filter(Boolean))
  const inWindow = (at) => (span === 'now' ? at >= since : at >= since && at <= now + MIN)
  const openNow = (issue) => OPEN.has(issue.status)
  // "Now" is the work in hand: a job a bot is on or has a run going on, and what was said on it today. A chat
  // counts for its last hour. The other windows count everything that happened in them.
  const isLive = (issue) => issue.status === 'in_progress' || liveJobs.has(issue.id)
  const counted = (issue, at) => (span !== 'now' ? inWindow(at) : isChat(issue) ? at >= since : isLive(issue) && at >= now - DAY)

  // ── the lines ───────────────────────────────────────────────────────────────────
  const edges = new Map()
  const scripts = new Map()
  const who = (author) => (author.agent ? (bots.has(author.agent) ? author.agent : null) : author.script ? scriptId(author.script) : 'owner')
  const titleOf = (issue) => short(plainTitle(withRefs(workName(issue.title || ''))), SHOWN_TITLE)
  const add = (kind, from, to, { at, issue, text = '', failed = false } = {}) => {
    if (!from || !to || from === to || !KINDS.has(kind)) return
    const key = `${kind}:${from}>${to}`
    const edge = edges.get(key) || { id: key, kind, from, to, count: 0, failed: 0, last: 0, lastFailed: false, messages: [] }
    edge.count += 1
    if (failed) edge.failed += 1
    if (at >= edge.last) { edge.last = at; edge.lastFailed = failed }
    edge.messages.push({ at, failed, text, job: issue ? { id: issue.id, ref: refOf(issue, projectNames), title: titleOf(issue) } : null })
    edges.set(key, edge)
  }
  /** Who asked for a job: the bot that made it, else the owner. */
  const askerOf = (issue) => (issue.createdByAgentId && bots.has(issue.createdByAgentId) ? issue.createdByAgentId : 'owner')
  const isChat = (issue) => Boolean(issue.conversationAgentId)
  const ideaOf = (issue) => {
    const parent = issue.parentId && byId.get(issue.parentId)
    return parent && parent.createdByAgentId && role(parent.createdByAgentId) === 'researcher' ? parent : null
  }
  /** What a job is, as a line: by its title's kind and the roles of the two ends. */
  const handOff = (issue) => {
    const what = kindOf(issue.title || '')
    const to = issue.assigneeAgentId
    const from = askerOf(issue)
    if (what.kind === 'check') return 'check'
    if (from !== 'owner' && role(from) === 'researcher') return 'idea'
    if (what.kind === 'ruling' || role(to) === 'ruler') return 'ask'
    if (from === 'owner') return 'order'
    if (role(from) === 'lead' && ideaOf(issue)) return 'start'
    return 'brief'
  }
  const runFailed = new Map()
  for (const run of runs) {
    const job = run.issueId || run.jobId
    if (job && FAILED_RUNS.has(run.status) && inWindow(stamp(run.finishedAt || run.startedAt || run.createdAt))) runFailed.set(job, true)
  }

  /** The bot whose work a check job checks, when it is one of the crew. */
  const builderOf = (issue) => {
    const what = kindOf(issue.title || '')
    const work = what.kind === 'check' ? byRef.get(what.of) : null
    return work?.assigneeAgentId && bots.has(work.assigneeAgentId) && work.assigneeAgentId !== issue.assigneeAgentId ? work.assigneeAgentId : null
  }
  for (const issue of issues) {
    if (isChat(issue) || !issue.assigneeAgentId || !bots.has(issue.assigneeAgentId)) continue
    const at = stamp(issue.createdAt)
    if (!counted(issue, at)) continue
    const failed = issue.status === 'cancelled' || issue.status === 'blocked' || runFailed.has(issue.id)
    const kind = handOff(issue)
    // A check runs from the work to its checker, so "who checks this bot" reads off the map; the lead who
    // asked for it is still on the job's page.
    const from = kind === 'check' ? builderOf(issue) || askerOf(issue) : askerOf(issue)
    const word = issue.status === 'done' ? 'Done' : issue.status === 'cancelled' ? 'Cancelled' : issue.status === 'blocked' ? 'Blocked' : 'Asked'
    add(kind, from, issue.assigneeAgentId, { at, issue, text: `${word}: ${titleOf(issue).replace(/^Checked: /, 'check of ')}`, failed })
  }

  for (const [jobId, list] of comments) {
    const issue = byId.get(jobId)
    if (!issue) continue
    for (const comment of list) {
      const at = stamp(comment.createdAt)
      if (!counted(issue, at)) continue
      const author = authorOf(comment)
      const from = who(author)
      if (!from) continue
      const text = firstLine(comment.body)
      if (author.script) {
        scripts.set(from, { name: author.script, count: (scripts.get(from)?.count || 0) + 1, last: Math.max(at, scripts.get(from)?.last || 0) })
        add('notice', from, issue.conversationAgentId || issue.assigneeAgentId || askerOf(issue), { at, issue, text })
        continue
      }
      if (isChat(issue)) {
        if (author.owner) add('order', 'owner', issue.conversationAgentId, { at, issue, text })
        else add('report', from, 'owner', { at, issue, text })
        continue
      }
      const doer = issue.assigneeAgentId
      const asker = askerOf(issue)
      const outcome = outcomeOf(comment.body)
      const what = kindOf(issue.title || '')
      if (author.owner) { add('order', 'owner', doer, { at, issue, text }); continue }
      if (from === doer) {
        // The one doing the job answers whoever asked for it.
        const kind = what.kind === 'check' && outcome ? 'verdict'
          : (what.kind === 'ruling' || role(from) === 'ruler') ? (role(asker) === 'researcher' || ideaOf(issue) || issue.createdByAgentId && role(issue.createdByAgentId) === 'researcher' ? (approves(comment.body) ? 'approval' : 'ruling') : 'ruling')
          : 'report'
        // A check's verdict goes back to the builder of the checked work, the line its check came along.
        const to = kind === 'verdict' ? builderOf(issue) || asker : asker
        add(kind, from, to, { at, issue, text, failed: outcome === 'not met' })
      } else if (['checker', 'reviewer'].includes(role(from)) && outcome) {
        add('verdict', from, doer, { at, issue, text, failed: outcome === 'not met' })
      } else if (role(from) === 'ruler') {
        add(role(asker) === 'researcher' && approves(comment.body) ? 'approval' : 'ruling', from, doer || asker, { at, issue, text })
      } else if (from === asker && role(from) === 'researcher') {
        add('idea', from, doer, { at, issue, text })
      } else if (from === asker || role(from) === 'lead') {
        add('brief', from, doer, { at, issue, text })
      } else {
        add('report', from, doer || asker, { at, issue, text })
      }
    }
  }

  // Cards that wait for the owner's answer, and who waits on them.
  const waitingCards = needs.filter((n) => ['approval', 'question'].includes(n.kind) && !n.archived)
  for (const card of waitingCards) {
    const issue = byId.get(card.id)
    const bot = card.botId && bots.has(card.botId) ? card.botId : issue?.conversationAgentId || issue?.assigneeAgentId || lead?.id
    if (!bot) continue
    // A card is itself the bot waiting on the owner: one line, not two.
    // Its time is its job's last move, not "now": the same card makes the same picture on every read.
    add('card', bot, 'owner', { at: issue ? touched(issue) : 0, issue: issue && !isChat(issue) ? issue : null, text: card.title || 'A card waits for you' })
  }
  // A job that cannot go on until another job moves: its bot waits on the other job's bot.
  for (const [jobId, list] of blockers) {
    const issue = byId.get(jobId)
    if (!issue?.assigneeAgentId || !openNow(issue)) continue
    for (const b of list) {
      if (!b || ['done', 'cancelled'].includes(b.status)) continue
      const other = b.assigneeAgentId && bots.has(b.assigneeAgentId) ? b.assigneeAgentId : null
      if (other) add('wait', issue.assigneeAgentId, other, { at: touched(issue), issue, text: `Waits on ${withRefs(b.identifier || '')} ${short(plainTitle(withRefs(b.title || '')), SHOWN_TITLE)}`.trim() })
    }
  }

  // ── the nodes ───────────────────────────────────────────────────────────────────
  const midnight = (() => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() })()
  const weekStart = costs.weekStart || now - WEEK
  const runsToday = new Map()
  for (const run of runs) {
    if (stamp(run.startedAt || run.createdAt) < midnight) continue
    const row = runsToday.get(run.agentId) || { runs: 0, failed: 0 }
    row.runs += 1
    if (FAILED_RUNS.has(run.status)) row.failed += 1
    runsToday.set(run.agentId, row)
  }
  const tokens = (row) => Number(row.inputTokens || 0) + Number(row.outputTokens || 0) + Number(row.cachedInputTokens || 0)
  const weekTokens = new Map(costs.week.map((row) => [row.agentId, tokens(row)]))
  const claudeWeek = agents.filter((a) => a.adapterType === 'claude_local').reduce((sum, a) => sum + (weekTokens.get(a.id) || 0), 0)

  // MET and NOT MET this week: the newest result each job of a bot states, or else the newest verdict on a check of it.
  const results = new Map()
  for (const issue of issues) {
    if (isChat(issue) || !issue.assigneeAgentId) continue
    const list = (comments.get(issue.id) || []).filter((c) => stamp(c.createdAt) >= weekStart && outcomeOf(c.body))
    if (!list.length) continue
    const newest = list.sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt))[0]
    const what = kindOf(issue.title || '')
    const target = what.kind === 'check' ? byRef.get(what.of) : issue
    if (!target?.assigneeAgentId) continue
    const kept = results.get(target.id)
    const at = stamp(newest.createdAt)
    // A job's own word wins over a check of it said earlier; else the newer one.
    const own = what.kind !== 'check'
    if (!kept || (own && kept.check) || (own === !kept.check && at > kept.at)) {
      results.set(target.id, { bot: target.assigneeAgentId, outcome: outcomeOf(newest.body), at, check: what.kind === 'check' })
    }
  }
  const tally = new Map()
  for (const r of results.values()) {
    const row = tally.get(r.bot) || { met: 0, notMet: 0 }
    if (r.outcome === 'met') row.met += 1
    else row.notMet += 1
    tally.set(r.bot, row)
  }

  const current = (agentId) => {
    const mine = issues.filter((i) => i.assigneeAgentId === agentId && !isChat(i) && (i.status === 'in_progress' || (liveJobs.has(i.id) && !['done', 'cancelled'].includes(i.status))))
    return mine.find((i) => liveJobs.has(i.id)) || mine.sort((a, b) => touched(b) - touched(a))[0] || null
  }
  /** Every job a bot holds now, the one it is running first: "checking 3". */
  const currentAll = (agentId) => issues.filter((i) => i.assigneeAgentId === agentId && !isChat(i) && (i.status === 'in_progress' || (liveJobs.has(i.id) && !['done', 'cancelled'].includes(i.status))))
    .sort((a, b) => Number(liveJobs.has(b.id)) - Number(liveJobs.has(a.id)) || touched(b) - touched(a))
  const jobView = (issue) => ({ id: issue.id, ref: refOf(issue, projectNames), title: titleOf(issue).replace(/^(Checked|Fixed|Decision): /, ''), stage: stageOf(issue), project: projectNames.get(issue.projectId) || '', projectId: issue.projectId || '' })
  const stageOf = (issue) => {
    const what = kindOf(issue.title || '')
    return what.kind === 'check' ? 'Checking' : what.kind === 'ruling' ? 'Ruling' : what.kind === 'fix' ? 'Fixing' : 'Building'
  }
  const nodes = [{
    id: 'owner', kind: 'owner', name: 'You', role: 'owner', roleName: 'Owner',
    needs: waitingCount(needs),
  }]
  for (const agent of agents) {
    const job = current(agent.id)
    const blocked = issues.some((i) => i.assigneeAgentId === agent.id && i.status === 'blocked')
    const status = liveBots.has(agent.id) ? 'working'
      : agent.status === 'paused' ? (rested[agent.id] ? 'resting' : 'paused')
      : agent.status === 'error' ? 'error'
      : job || blocked ? 'waiting'
      : 'free'
    const look = looks.get(agent.id)
    const family = copyOn.get(agent.id)
    const running = family?.agent || agent
    const held = currentAll(agent.id)
    const runsRow = runsToday.get(agent.id) || { runs: 0, failed: 0 }
    const claude = agent.adapterType === 'claude_local'
    const own = weekTokens.get(agent.id) || 0
    nodes.push({
      id: agent.id,
      kind: 'bot',
      name: agent.name,
      title: agent.title || '',
      role: look.role,
      roleName: ROLE_NAMES[look.role] || 'Crew',
      look: look.look,
      reportsTo: agent.reportsTo && bots.has(agent.reportsTo) ? agent.reportsTo : null,
      under: agent.reportsTo && bots.has(agent.reportsTo) ? agent.reportsTo : look.role === 'lead' || !lead || lead.id === agent.id ? 'owner' : lead.id,
      model: modelLabel(running.adapterConfig?.model),
      engine: ENGINE[running.adapterType] || 'Other',
      // A bot with copies on other AIs is one node: the tag says which copy is running.
      ...(family ? { copies: family.copies.map((a) => ({ id: a.id, name: a.name, engine: ENGINE[a.adapterType] || 'Other', model: modelLabel(a.adapterConfig?.model), running: a.id === running.id })), on: ENGINE[running.adapterType] || 'Other' } : {}),
      status,
      why: status === 'resting' ? rested[agent.id]?.text || '' : !job && live.some((r) => r.agentId === agent.id && isChat(byId.get(r.issueId) || {})) ? 'Talking with you in its chat' : '',
      job: job ? jobView(job) : null,
      jobs: held.map(jobView),
      runsToday: runsRow.runs,
      failedToday: runsRow.failed,
      week: { tokens: own, share: claude && claudeWeek ? own / claudeWeek : claude ? 0 : null },
      met: tally.get(agent.id)?.met || 0,
      notMet: tally.get(agent.id)?.notMet || 0,
    })
  }
  for (const [id, s] of [...scripts].sort((a, b) => b[1].count - a[1].count)) nodes.push({ id, kind: 'script', name: s.name, role: 'script', roleName: 'Script', notices: s.count, last: s.last })

  // ── the project lanes, in the owner's work order ───────────────────────────────
  const shelved = new Set(guard.shelved || [])
  const ranked = guard.ranked || []
  const at = new Map(ranked.map((name, i) => [name, i]))
  const lanes = projects.filter((p) => !shelved.has(p.name))
    .map((p, i) => ({ p, r: at.has(p.name) ? at.get(p.name) : ranked.length + i }))
    .sort((a, b) => a.r - b.r)
    .map(({ p }, rank) => {
      const jobs = issues.filter((i) => i.projectId === p.id && !isChat(i))
      return {
        id: p.id,
        name: p.name,
        rank: rank + 1,
        open: jobs.filter(openNow).length,
        running: jobs.filter((i) => i.status === 'in_progress').length,
        bots: nodes.filter((n) => n.kind === 'bot' && n.job?.projectId === p.id).map((n) => n.id),
      }
    })

  const list = [...edges.values()].map((e) => ({ ...e, messages: e.messages.sort((a, b) => b.at - a.at).slice(0, SHOWN_MESSAGES) }))
    .sort((a, b) => EDGE_KINDS.findIndex((k) => k.kind === a.kind) - EDGE_KINDS.findIndex((k) => k.kind === b.kind) || b.count - a.count)
  return { at: now, window: span, since, nodes, edges: list, lanes, kinds: EDGE_KINDS, needs: waitingCount(needs) }
}

// ── reading it ────────────────────────────────────────────────────────────────────

/** A job's comments, read again only when the job has moved since. */
const commentsSeen = new Map()
const blockersSeen = new Map()

async function inTurns(items, act) {
  const out = []
  for (let i = 0; i < items.length; i += AT_ONCE) out.push(...await Promise.all(items.slice(i, i + AT_ONCE).map(act)))
  return out
}

async function commentsOf(issues, options) {
  const keep = options?.fetcher ? new Map() : commentsSeen
  const out = new Map()
  await inTurns(issues, async (issue) => {
    const moved = touched(issue)
    const seen = keep.get(issue.id)
    if (seen && seen.moved === moved) return void out.set(issue.id, seen.list)
    const list = await orElse(call(`/issues/${issue.id}/comments?limit=${COMMENTS_PER_JOB}`, options), [])
    keep.set(issue.id, { moved, list })
    out.set(issue.id, list)
  })
  return out
}

async function blockersOf(issues, options) {
  const keep = options?.fetcher ? new Map() : blockersSeen
  const out = new Map()
  await inTurns(issues, async (issue) => {
    const moved = touched(issue)
    const seen = keep.get(issue.id)
    if (seen && seen.moved === moved) return void out.set(issue.id, seen.list)
    const list = await orElse(call(`/issues/${issue.id}/blockers`, options), [])
    keep.set(issue.id, { moved, list })
    out.set(issue.id, list)
  })
  return out
}

/** When the Claude week began: the crew's pace file knows its reset; without it, seven days back. */
export function weekStartOf(pace = {}, now = Date.now()) {
  const resets = Number(pace?.resets) * 1000
  return resets > now && resets - WEEK < now ? resets - WEEK : now - WEEK
}

/**
 * What changed, in one short string: the jobs (a comment moves its job too), the live runs and the bots.
 * Two equal stamps mean nothing the flow or the cards are made of has moved.
 */
export function changeStamp({ issues = [], live = [], agents = [], chats = [] } = {}) {
  let newest = 0
  for (const i of [...issues, ...chats]) newest = Math.max(newest, touched(i), stamp(i.updatedAt))
  return [issues.length, newest, live.map((r) => r.id).sort().join(','), agents.map((a) => `${a.id}:${a.status}`).join(',')].join('|')
}

/**
 * One kept answer: served for up to `ms` while the stamp of what it was made from stays the same, and
 * dropped at once by `drop()` (the page's own writes: a job, a comment, a card).
 */
export function keptAnswer(ms) {
  const kept = new Map()
  let running = new Map()
  return {
    async get(key, stampNow, make) {
      const hit = kept.get(key)
      if (hit && Date.now() - hit.at < ms && hit.stamp === stampNow) return hit.value
      if (running.has(key)) return running.get(key)
      const job = make().then((value) => { kept.set(key, { at: Date.now(), stamp: stampNow, value }); return value })
        .finally(() => running.delete(key))
      running.set(key, job)
      return job
    },
    drop() { kept.clear(); running = new Map() },
    size: () => kept.size,
  }
}

const flowKept = keptAnswer(FLOW_TTL_MS)
const needsKept = keptAnswer(FLOW_TTL_MS)

/** A job, a comment or a card was just changed from the page: the next read works both out again. */
export function dropFlow() { flowKept.drop(); needsKept.drop() }
export const flowCacheSize = () => flowKept.size() + needsKept.size()

/** The records the stamp is taken from, read cheaply: the job list, the live runs and the crew. */
async function quickRecords(options) {
  const id = await companyId(options)
  const [agents, issues, live, chats] = await Promise.all([
    crewOf(id, options),
    call(`/companies/${id}/issues?limit=100000`, options),
    orElse(call(`/companies/${id}/live-runs`, options), []),
    orElse(call(`/companies/${id}/chats`, options), []),
  ])
  return { id, agents, issues, live, chats }
}

/**
 * "Needs you", with each card's read and archived state: kept ten seconds, dropped on any change.
 * `read` works the list out (the engine's summary); passed in so the server and a test give their own.
 */
export async function needsList({ read, ...options } = {}) {
  const quick = await quickRecords(options)
  return needsKept.get('needs', changeStamp(quick), read)
}

/** The flow for a window, kept ten seconds and dropped on any change. */
export async function crewFlow({ window = '24h', needs, folder = crewFolder(), now = () => Date.now(), ...options } = {}) {
  const span = WINDOWS[window] ? window : '24h'
  const quick = await quickRecords(options)
  return flowKept.get(span, changeStamp(quick), async () => {
    const at = now()
    const { id, agents, issues, live, chats } = quick
    const files = readCrewFiles(folder)
    const weekStart = weekStartOf(files.pace, at)
    const reach = Math.min(at - WINDOWS[span], weekStart)
    // Comments are read for the jobs that moved since the earlier of the window and the week (MET counts the week).
    const moved = [...issues, ...chats].filter((i) => touched(i) >= reach).sort((a, b) => touched(b) - touched(a)).slice(0, MOST_JOBS)
    const waiting = issues.filter((i) => ['blocked', 'todo'].includes(i.status) && i.assigneeAgentId).slice(0, 80)
    const [projects, runs, week, comments, blockers, cards] = await Promise.all([
      orElse(call(`/companies/${id}/projects`, options), []),
      orElse(call(`/companies/${id}/heartbeat-runs?limit=500&summary=true`, options), []),
      orElse(call(`/companies/${id}/costs/by-agent?from=${encodeURIComponent(new Date(weekStart).toISOString())}`, options), []),
      commentsOf(moved, options),
      blockersOf(waiting, options),
      needs ? needs().catch(() => []) : [],
    ])
    return buildFlow({
      agents, issues, chats, projects: projects.filter((p) => !p.archivedAt), live, runs, comments, needs: cards, blockers,
      costs: { week, weekStart }, guard: options.guard || readGuard(guardFolder()), rested: options.rested || readRested(folder, at), window: span, now: at,
    })
  })
}

/**
 * The Crew sheet's list with each bot's week from the flow: its share of the Claude week (cached reads
 * included) and its MET and NOT MET results, so the sheet and the map say the same.
 */
export function withWeek(list, flow) {
  const nodes = new Map((flow?.nodes || []).filter((n) => n.kind === 'bot').map((n) => [n.id, n]))
  return {
    ...list,
    bots: (list?.bots || []).map((b) => {
      const n = nodes.get(b.id)
      return n ? { ...b, claudeShare: n.week?.share ?? null, weekTokensAll: n.week?.tokens || 0, met: n.met, notMet: n.notMet } : b
    }),
    weekKnown: Boolean(flow),
  }
}
