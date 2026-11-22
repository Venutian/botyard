/**
 * The rest of what the map reads, answered from Botyard's store: what needs a look, the activity
 * feed, tokens by window, who reports to whom, the things the crew made, and the company's own few
 * facts. These are the paths `http.mjs` does not have; together the two cover every read the map
 * makes.
 *
 * Each answer has the shape the map reads, and no more than the map reads.
 */
import { displayOf } from './codes.mjs'
import { instructionsBundle, instructionsDiff, instructionsFile, instructionsHistory, instructionsPage } from './bots.mjs'
import { blockers, inbox, jobContext, products, settings } from './extras.mjs'
import { jobCounts } from './read.mjs'
import { Refused } from './write.mjs'

const HOUR = 3_600_000
const PACE_HOLD = /Held by the free pace/i
const DAY = 24 * HOUR
const iso = (ms) => new Date(ms).toISOString()
const company = (store, id) => {
  const found = store.object('SELECT raw FROM company WHERE id = ?', id)
  if (!found) throw new Refused(404, 'Company not found')
  return found
}

/** What needs a look: cards still waiting for the owner, and runs that failed on jobs still open. */
export function attention(store, companyId, { now = Date.now() } = {}) {
  company(store, companyId)
  const items = []
  for (const card of store.objects("SELECT raw FROM cards WHERE status = 'pending' ORDER BY created_at DESC")) {
    const job = store.object('SELECT raw FROM jobs WHERE id = ?', card.issueId)
    // A card in a conversation is shown in that conversation, not in this feed. A card still waiting on a job marked
    // done is still the owner's to answer (an idea's stop card, say): it is shown. Only a cancelled job's card is moot.
    if (!job || job.conversationAgentId || job.status === 'cancelled') continue
    items.push({ companyId, sourceKind: 'issue_thread_interaction', subject: { kind: 'interaction', id: card.id, companyId, title: card.title || 'A bot asks you', identifier: job.identifier, status: 'pending', metadata: { issueId: job.id, kind: card.kind } }, whyNow: card.kind === 'request_confirmation' && card.summary ? `${displayOf(store, job.identifier)}: ${String(card.summary).replace(/\s+/g, ' ').slice(0, 280).trim()}${String(card.summary).length > 280 ? '…' : ''}` : `${displayOf(store, job.identifier)} is waiting for your answer.`, inlineResolvable: true })
  }
  const seen = new Set()
  const names = new Map(store.rows('SELECT id, name FROM agents').map((a) => [a.id, a.name]))
  for (const row of store.rows("SELECT id, agent_id, job_id, status, error, finished_at FROM runs WHERE created_at >= ? ORDER BY created_at DESC", iso(now - 2 * DAY))) {
    // Only the newest run of a bot on a job counts: an old failure a later run got past is history.
    const key = `${row.agent_id}:${row.job_id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!['failed', 'timed_out'].includes(row.status) || !row.job_id) continue
    if (PACE_HOLD.test(row.error || '')) continue
    const job = store.row('SELECT status, identifier FROM jobs WHERE id = ?', row.job_id)
    if (!job || ['done', 'cancelled'].includes(job.status)) continue
    const who = names.get(row.agent_id) || 'A bot'
    items.push({ companyId, sourceKind: 'failed_run', subject: { kind: 'run', id: row.id, companyId, title: `${who} run failed`, identifier: null, status: row.status, metadata: { agentId: row.agent_id, agentName: who, issueId: row.job_id, error: row.error || '' } }, whyNow: row.status === 'timed_out' ? 'Its run was stopped at its time limit.' : `Its run failed${row.error ? `: ${String(row.error).slice(0, 200)}` : '.'}`, inlineResolvable: true })
  }
  return { companyId, generatedAt: iso(now), totalCount: items.length, deskBadgeCount: items.length, nextCursor: null, items }
}

export const badges = (store, companyId, ctx) => ({ inbox: 0, approvals: 0, failedRuns: attention(store, companyId, ctx).items.filter((i) => i.sourceKind === 'failed_run').length, joinRequests: 0 })

/** The month's spend. Every run is on a subscription, so money is nothing; the tokens are in the windows below. */
export function dashboard(store, companyId, { now = Date.now() } = {}) {
  company(store, companyId)
  const open = (status) => store.row('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status).n
  return { companyId, generatedAt: iso(now), costs: { monthSpendCents: 0, monthBudgetCents: 0 }, tasks: { open: open('todo') + open('backlog'), inProgress: open('in_progress'), blocked: open('blocked'), done: open('done') }, agents: { active: store.row("SELECT COUNT(*) AS n FROM agents WHERE status != 'paused'").n, paused: store.row("SELECT COUNT(*) AS n FROM agents WHERE status = 'paused'").n } }
}

/** Tokens used in the last five hours, day and week, by provider. */
export function windowSpend(store, companyId, { now = Date.now() } = {}) {
  company(store, companyId)
  const out = []
  for (const [window, hours] of [['5h', 5], ['24h', 24], ['7d', 168]]) {
    for (const row of store.rows('SELECT provider, biller, SUM(input_tokens) AS i, SUM(cached_input_tokens) AS c, SUM(output_tokens) AS o FROM usage WHERE occurred_at >= ? GROUP BY provider, biller', iso(now - hours * HOUR))) {
      out.push({ provider: row.provider, biller: row.biller || row.provider, window, windowHours: hours, costCents: 0, costCentsExact: '0.0000000', inputTokens: row.i || 0, cachedInputTokens: row.c || 0, outputTokens: row.o || 0 })
    }
  }
  return out
}

/** Who reports to whom. */
export function org(store, companyId) {
  company(store, companyId)
  const all = store.objects('SELECT raw FROM agents WHERE company_id = ? ORDER BY created_at', companyId)
  const under = (id, trail) => all.filter((a) => (a.reportsTo || null) === id && !trail.has(a.id)).map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, reports: under(a.id, new Set([...trail, a.id])) }))
  return under(null, new Set())
}

/** Who did what, lately: jobs made and given out, what was said, and each run with how it ended. */
export function timeline(store, companyId, { now = Date.now() } = {}) {
  company(store, companyId)
  const since = iso(now - 3 * DAY)
  const names = new Map(store.rows('SELECT id, name FROM agents').map((a) => [a.id, a.name]))
  const actors = new Map([['user:local-board', { id: 'user:local-board', type: 'user', name: 'Board', avatar: null }]])
  const actor = (agentId) => {
    if (!agentId) return 'user:local-board'
    const id = `agent:${agentId}`
    if (!actors.has(id)) actors.set(id, { id, type: 'agent', name: names.get(agentId) || 'A bot', avatar: null })
    return id
  }
  const events = []
  const edges = []
  for (const job of store.rows('SELECT id, created_by_agent_id, assignee_agent_id, created_at, completed_at, status FROM jobs WHERE created_at >= ? OR completed_at >= ? ORDER BY created_at DESC LIMIT 400', since, since)) {
    if (job.created_at >= since) {
      const from = actor(job.created_by_agent_id)
      events.push({ actorId: from, kind: 'created', issueId: job.id, at: job.created_at })
      if (job.assignee_agent_id) edges.push({ fromActorId: from, toActorId: actor(job.assignee_agent_id), issueId: job.id, at: job.created_at, kind: 'assignment' })
    }
    if (job.completed_at && job.completed_at >= since && job.status === 'done') events.push({ actorId: actor(job.assignee_agent_id), kind: 'completed', issueId: job.id, at: job.completed_at })
  }
  for (const c of store.rows('SELECT job_id, author_agent_id, created_at FROM comments WHERE created_at >= ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 400', since)) events.push({ actorId: actor(c.author_agent_id), kind: 'commented', issueId: c.job_id, at: c.created_at })
  const spans = store.rows('SELECT id, agent_id, job_id, status, started_at, finished_at, invocation_source, retry_of_run_id FROM runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 400', since)
    .map((r) => ({ actorId: actor(r.agent_id), laneHint: r.invocation_source, runId: r.id, issueId: r.job_id, start: r.started_at, end: r.finished_at, status: r.status, retryOfRunId: r.retry_of_run_id, invocationSource: r.invocation_source }))
  return { actors: [...actors.values()], spans, events, edges, pagination: { limit: 400, offset: 0, hasMore: false } }
}

const KIND_OF = (type = '') => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type === 'application/pdf' || type.includes('document') ? 'document' : type.startsWith('text/') ? 'text' : 'file')
const PAGE_MAX = 100

/** What the crew made: every file on a job and every job document, newest first, a page at a time. */
export function artifacts(store, companyId, query = {}) {
  company(store, companyId)
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.limit) || 60))
  let offset = 0
  if (query.cursor) { try { offset = Math.max(0, Number(JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString()).offset) || 0) } catch { throw new Refused(400, 'That is not a page') } }
  const kind = query.kind && query.kind !== 'all' ? String(query.kind) : ''
  const names = new Map(store.rows('SELECT id, name FROM agents').map((a) => [a.id, a.name]))
  const projects = new Map(store.rows('SELECT id, name FROM projects').map((p) => [p.id, p.name]))
  const jobOf = (id) => store.row('SELECT id, identifier, title, project_id FROM jobs WHERE id = ?', id)
  const all = []
  for (const a of store.objects('SELECT raw FROM attachments ORDER BY created_at DESC')) {
    const job = jobOf(a.issueId)
    const place = `/api/attachments/${a.id}/content`
    all.push({ id: `attachment:${a.id}`, source: 'attachment', mediaKind: KIND_OF(a.contentType), title: a.originalFilename || 'File', previewText: null, contentType: a.contentType, contentPath: place, openPath: place, downloadPath: `${place}?download=1`, issue: job ? { id: job.id, identifier: job.identifier, title: job.title } : null, project: job?.project_id ? { id: job.project_id, name: projects.get(job.project_id) || '' } : null, createdByAgent: a.createdByAgentId ? { id: a.createdByAgentId, name: names.get(a.createdByAgentId) || '' } : null, updatedAt: a.updatedAt || a.createdAt })
  }
  for (const row of store.rows('SELECT d.raw AS raw, jd.job_id AS job_id, jd.key AS key FROM documents d JOIN job_documents jd ON jd.document_id = d.id ORDER BY d.updated_at DESC')) {
    const d = JSON.parse(row.raw)
    const job = jobOf(row.job_id)
    all.push({ id: `document:${d.id}`, source: 'document', mediaKind: 'document', title: d.title || row.key, previewText: String(d.body || d.latestBody || '').slice(0, 240), contentType: 'text/markdown', contentPath: null, openPath: null, downloadPath: null, issue: job ? { id: job.id, identifier: job.identifier, title: job.title } : null, project: job?.project_id ? { id: job.project_id, name: projects.get(job.project_id) || '' } : null, createdByAgent: null, updatedAt: d.updatedAt || d.createdAt })
  }
  const shown = all.filter((a) => !kind || a.mediaKind === kind).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)))
  const page = shown.slice(offset, offset + limit)
  return { artifacts: page, nextCursor: offset + limit < shown.length ? Buffer.from(JSON.stringify({ offset: offset + limit })).toString('base64url') : null }
}

/** The one person in the company: the owner. Nobody was ever invited. */
export function members(store, companyId) {
  const c = company(store, companyId)
  return { members: [{ id: 'owner', companyId, principalType: 'user', principalId: 'local-board', status: 'active', membershipRole: 'owner', createdAt: c.createdAt || null, updatedAt: c.updatedAt || null, user: { id: 'local-board', email: '', name: 'Owner', image: null }, grants: [] }], access: { currentUserRole: 'owner', canManageMembers: true, canInviteUsers: false, canApproveJoinRequests: false } }
}

/**
 * Find jobs by words: in the code, the title, the description, and what was said on them. Every word
 * must be there; a hit in the title ranks first. The same filters as the job list apply.
 */
export function search(store, companyId, query = {}) {
  company(store, companyId)
  const words = String(query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
  const offset = Math.max(0, Number(query.offset) || 0)
  if (!words.length) return { query: '', scope: 'issues', limit, offset, results: [], zeroResults: true, hasMore: false }
  const statuses = String(query.status || '').split(',').filter(Boolean)
  const results = []
  for (const row of store.rows('SELECT id, identifier, title, description, status, project_id, assignee_agent_id, updated_at, raw FROM jobs WHERE company_id = ? AND hidden_at IS NULL ORDER BY updated_at DESC', companyId)) {
    if (statuses.length && !statuses.includes(row.status)) continue
    if (query.projectId && row.project_id !== query.projectId) continue
    if (query.assigneeAgentId && row.assignee_agent_id !== query.assigneeAgentId) continue
    const shown = displayOf(store, row.identifier)
    const head = `${row.identifier} ${shown} ${row.title}`.toLowerCase()
    const body = String(row.description || '').toLowerCase()
    let said = null
    const inSaid = () => (said ??= store.rows('SELECT body FROM comments WHERE job_id = ? AND deleted_at IS NULL', row.id).map((c) => String(c.body || '')).join('\n').toLowerCase())
    if (!words.every((w) => head.includes(w) || body.includes(w) || inSaid().includes(w))) continue
    const inTitle = words.every((w) => head.includes(w))
    const where = inTitle ? row.title : body.includes(words[0]) ? String(row.description) : said ? store.rows('SELECT body FROM comments WHERE job_id = ? AND deleted_at IS NULL', row.id).map((c) => String(c.body || '')).find((b) => b.toLowerCase().includes(words[0])) || row.title : row.title
    const at = Math.max(0, where.toLowerCase().indexOf(words[0]) - 60)
    results.push({ id: row.id, type: 'issue', score: inTitle ? 2 : 1, title: `${shown} ${row.title}`, snippet: inTitle ? row.title : `${at ? '...' : ''}${where.slice(at, at + 200).replace(/\s+/g, ' ')}`, issue: JSON.parse(row.raw) })
  }
  results.sort((a, b) => b.score - a.score)
  return { query: String(query.q), scope: 'issues', limit, offset, results: results.slice(offset, offset + limit), zeroResults: !results.length, hasMore: offset + limit < results.length }
}

/** What a job has used: the tokens and time of its runs, and of the jobs under it. */
export function costSummary(store, jobRef) {
  const job = store.row('SELECT id FROM jobs WHERE id = ? OR identifier = ?', jobRef, jobRef)
  if (!job) throw new Refused(404, 'Issue not found')
  const ids = [job.id]
  for (let n = 0; n < ids.length && ids.length < 500; n++) for (const child of store.rows('SELECT id FROM jobs WHERE parent_id = ?', ids[n])) if (!ids.includes(child.id)) ids.push(child.id)
  // costUsd: what the tools said each run cost, added up over the job, every job under it and every round (a request's whole cost).
  const out = { issueId: job.id, issueCount: ids.length, includeDescendants: true, costCents: 0, costCentsExact: '0.0000000', costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0, runtimeMs: 0 }
  for (const id of ids) {
    for (const run of store.rows('SELECT usage_json, started_at, finished_at FROM runs WHERE job_id = ?', id)) {
      let usage = {}
      try { usage = JSON.parse(run.usage_json || '{}') || {} } catch { /* no usage kept */ }
      out.inputTokens += Number(usage.inputTokens) || 0
      out.cachedInputTokens += Number(usage.cachedInputTokens) || 0
      out.outputTokens += Number(usage.outputTokens) || 0
      out.costUsd += Number(usage.costUsd) || 0
      out.runCount += 1
      if (run.started_at && run.finished_at) out.runtimeMs += Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at))
    }
  }
  out.costUsd = Math.round(out.costUsd * 10_000) / 10_000
  return out
}

const one = '([^/]+)'
/** The paths answered here: (store, parts, query, ctx) → the answer. */
const PATHS = [
  [`/companies/${one}/attention`, (s, p, q, c) => attention(s, p[0], c)],
  [`/companies/${one}/sidebar-badges`, (s, p, q, c) => badges(s, p[0], c)],
  [`/companies/${one}/dashboard`, (s, p, q, c) => dashboard(s, p[0], c)],
  [`/companies/${one}/approvals`, (s, p) => { company(s, p[0]); return [] }],
  [`/companies/${one}/costs/window-spend`, (s, p, q, c) => windowSpend(s, p[0], c)],
  // No provider's own limits are read by the engine: the crew's token guard measures them from the run logs.
  [`/companies/${one}/costs/quota-windows`, (s, p) => { company(s, p[0]); return [] }],
  [`/companies/${one}/budgets/overview`, (s, p) => { company(s, p[0]); return { policies: [] } }],
  [`/companies/${one}/org`, (s, p) => org(s, p[0])],
  [`/companies/${one}/search`, (s, p, q) => search(s, p[0], q)],
  [`/companies/${one}/job-counts`, (s, p, q) => { company(s, p[0]); return jobCounts(s, p[0], q) }],
  [`/companies/${one}/timeline`, (s, p, q, c) => timeline(s, p[0], c)],
  [`/companies/${one}/artifacts`, (s, p, q) => artifacts(s, p[0], q)],
  [`/companies/${one}/members`, (s, p) => members(s, p[0])],
  [`/companies/${one}/invites`, (s, p) => { company(s, p[0]); return [] }],
  // Connectors' keys are Botyard's own (the Connectors page); the engine holds no secrets.
  [`/companies/${one}/secrets`, (s, p) => { company(s, p[0]); return [] }],
  // The skills are the ones on this computer, read by the map itself.
  [`/companies/${one}/skills`, (s, p) => { company(s, p[0]); return [] }],
  [`/agents/${one}/skills`, () => ({ desiredSkills: [], entries: [] })],
  [`/agents/${one}/instructions-bundle`, (s, p, q, c) => instructionsBundle(s, p[0], c)],
  [`/agents/${one}/instructions-bundle/file`, (s, p, q, c) => instructionsFile(s, p[0], q, c)],
  [`/agents/${one}/instructions-bundle/history`, (s, p) => instructionsHistory(s, p[0])],
  [`/agents/${one}/instructions-bundle/diff`, (s, p, q) => instructionsDiff(s, p[0], q)],
  [`/agents/${one}/instructions`, (s, p, q, c) => instructionsPage(s, p[0], c)],
  // A project's goal is in its own text; there are no goals apart from it.
  [`/companies/${one}/goals`, (s, p) => { company(s, p[0]); return [] }],
  [`/issues/${one}/cost-summary`, (s, p) => costSummary(s, p[0])],
  [`/instance/settings/${one}`, (s, p) => settings(s, p[0])],
  // What a bot asks about its own work by itself.
  [`/agents/${one}/inbox-lite`, (s, p) => inbox(s, p[0])],
  // A bot's secrets are in its run's own variables; there are none to list.
  [`/agents/${one}/secrets`, () => []],
  [`/issues/${one}/heartbeat-context`, (s, p) => jobContext(s, p[0])],
  [`/issues/${one}/blockers`, (s, p) => blockers(s, p[0])],
  [`/issues/${one}/recovery-actions`, () => []],
  [`/issues/${one}/work-products`, (s, p) => products(s, p[0])],
  [`/companies/${one}/skills/${one}`, () => { throw new Refused(404, 'Skill not found') }],
  [`/companies/${one}/skills/${one}/files`, () => { throw new Refused(404, 'Skill not found') }],
]
const ROUTES = PATHS.map(([pattern, act]) => [new RegExp(`^${pattern}$`), act])

export const MORE_PATHS = PATHS.map(([pattern]) => pattern.replaceAll(one, ':id'))

/** The answer for a path this file knows, or null when it is not one of them. */
export function more(store, where, query, ctx) {
  for (const [pattern, act] of ROUTES) {
    const match = pattern.exec(where)
    if (match) return { status: 200, body: act(store, match.slice(1).map((part) => decodeURIComponent(part)), query, ctx) }
  }
  return null
}
