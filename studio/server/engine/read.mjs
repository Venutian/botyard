/**
 * The questions the crew and the map ask, answered from Botyard's own store with the same JSON
 * the API has always given. Every function takes an open store and plain values, reads, and returns the body;
 * what is refused or not found is thrown as `Refused` with the status to send.
 *
 * Nothing here writes. An answer is the object the import kept (`raw`); the columns only choose the
 * rows and their order. Where the API gives the same thing in a shorter shape (a job in a list, a
 * bot in a list, a chat, a run in the run list), the shorter shape is made from the kept one.
 */
import { unpack } from './store.mjs'
import { cardAsRead } from './write.mjs'

export class Refused extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const missing = (what) => new Refused(404, `${what} not found`)

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const JOB_CODE = /^[A-Z][A-Z0-9]*-\d+$/
const JOB_LIST_DEFAULT = 500
const JOB_LIST_MAX = 1000
const JOB_LIST_DESCRIPTION = 1200
const COMMENT_LIST_MAX = 500
const RUN_LIST_MAX = 1000
const LIVE_RUN_MAX = 50
const RESULT_WORDS = 500
const SEARCH_MAX_CHARS = 200
const SEARCH_MAX_WORDS = 8
const LIVE = "('queued', 'running')"
// The one person of a Botyard: chats are listed for whoever asks, and here that is the owner.
export const OWNER = 'local-board'

const omit = (object, keys) => {
  const out = {}
  for (const [k, v] of Object.entries(object)) if (!keys.includes(k)) out[k] = v
  return out
}

// ───────── company, bots, projects ─────────

export const companies = (store) => store.objects('SELECT raw FROM company ORDER BY id')

export function company(store, id) {
  const found = store.object('SELECT raw FROM company WHERE id = ?', id)
  if (!found) throw missing('Company')
  return found
}

// A bot's own page says who it answers to and what it may do; the list leaves both out.
const AGENT_PAGE_ONLY = ['chainOfCommand', 'access']

/** GET /companies/:id/agents. The oldest bot is first. */
export const agents = (store, companyId, query = {}) => store.objects(`SELECT raw FROM agents WHERE company_id = ?${query.includeTerminated === 'true' ? '' : " AND status != 'terminated'"} ORDER BY created_at, id`, companyId).map((a) => omit(a, AGENT_PAGE_ONLY))

function agentRow(store, ref, companyId = null) {
  const raw = String(ref ?? '').trim()
  if (ID.test(raw)) return store.row(`SELECT id, raw FROM agents WHERE id = ?${companyId ? ' AND company_id = ?' : ''}`, ...(companyId ? [raw.toLowerCase(), companyId] : [raw.toLowerCase()]))
  // A bot can also be named by the short name in its address ("the-lead").
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!key) return null
  const matches = store.rows(`SELECT id, raw FROM agents WHERE url_key = ? AND status != 'terminated'${companyId ? ' AND company_id = ?' : ''}`, ...(companyId ? [key, companyId] : [key]))
  return matches.length === 1 ? matches[0] : null
}

export function agent(store, ref) {
  const found = agentRow(store, ref)
  if (!found) throw missing('Agent')
  return unpack(found.raw)
}

export function taskSessions(store, agentRef) {
  const found = agentRow(store, agentRef)
  if (!found) throw missing('Agent')
  return store.objects('SELECT raw FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC, position', found.id)
}

export function configRevisions(store, agentRef) {
  const found = agentRow(store, agentRef)
  if (!found) throw missing('Agent')
  return store.objects('SELECT raw FROM agent_revisions WHERE agent_id = ? ORDER BY position', found.id)
}

export const projects = (store, companyId) => store.objects('SELECT raw FROM projects WHERE company_id = ? ORDER BY position, created_at', companyId)

// The list counts a project's jobs and names its budget; the project's own page does neither.
const PROJECT_LIST_ONLY = ['taskCount', 'budget']

export function project(store, id) {
  const found = ID.test(String(id)) ? store.object('SELECT raw FROM projects WHERE id = ?', id) : store.object('SELECT raw FROM projects WHERE url_key = ?', String(id).toLowerCase())
  if (!found) throw missing('Project')
  return omit(found, PROJECT_LIST_ONLY)
}

// ───────── jobs ─────────

/** The row of a job named by its id or by its code (LH-12, in any case). */
function jobRow(store, ref) {
  const raw = String(ref ?? '').trim()
  if (ID.test(raw)) return store.row('SELECT * FROM jobs WHERE id = ?', raw.toLowerCase())
  const code = raw.toUpperCase()
  return JOB_CODE.test(code) ? store.row('SELECT * FROM jobs WHERE identifier = ?', code) : null
}
function jobOr404(store, ref) {
  const found = jobRow(store, ref)
  if (!found) throw missing('Issue')
  return found
}

// A job's page names other things: the jobs above it, the ones that block it or mention it, its
// project and its work folder. Those lines were true when the page was kept; these are the fields of
// each that are brought up to date from the thing's own row, so a page does not go on calling a
// finished blocker open. (Which things are named is as it was when the page was kept.)
const JOB_LINE = ['identifier', 'title', 'status', 'priority', 'assigneeAgentId', 'assigneeUserId']
const ANCESTOR_LINE = ['identifier', 'title', 'description', 'status', 'priority', 'assigneeAgentId', 'projectId', 'goalId']
const PROJECT_KEPT = ['workspaces', 'primaryWorkspace']
const FOLDER_KEPT = ['metadata']

function current(store, page) {
  const pages = new Map()
  const pageOf = (id) => {
    if (!pages.has(id)) pages.set(id, id === page.id ? page : store.object('SELECT raw FROM jobs WHERE id = ?', id))
    return pages.get(id)
  }
  const line = (named, fields) => {
    const now = named?.id ? pageOf(named.id) : null
    if (!now) return named
    const out = { ...named }
    for (const field of fields) if (field in named && field in now) out[field] = now[field]
    return out
  }
  const whole = (named, now, kept) => {
    if (!named || !now) return named
    const out = { ...named }
    for (const field of Object.keys(named)) if (!kept.includes(field) && field in now) out[field] = now[field]
    return out
  }
  const out = { ...page }
  if (Array.isArray(page.ancestors)) out.ancestors = page.ancestors.map((a) => line(a, ANCESTOR_LINE))
  if (Array.isArray(page.blockedBy)) out.blockedBy = page.blockedBy.map((b) => line(b, JOB_LINE))
  if (Array.isArray(page.blocks)) out.blocks = page.blocks.map((b) => line(b, JOB_LINE))
  if (page.relatedWork && typeof page.relatedWork === 'object') {
    out.relatedWork = { ...page.relatedWork }
    for (const side of ['inbound', 'outbound']) if (Array.isArray(page.relatedWork[side])) out.relatedWork[side] = page.relatedWork[side].map((r) => (r?.issue ? { ...r, issue: line(r.issue, JOB_LINE) } : r))
  }
  if (page.project?.id) out.project = whole(page.project, store.object('SELECT raw FROM projects WHERE id = ?', page.project.id), PROJECT_KEPT)
  if (page.currentExecutionWorkspace?.id) out.currentExecutionWorkspace = whole(page.currentExecutionWorkspace, store.object('SELECT raw FROM workspaces WHERE id = ?', page.currentExecutionWorkspace.id), FOLDER_KEPT)
  return out
}

/** GET /issues/:id, by id or by code. */
export const job = (store, ref) => current(store, unpack(jobOr404(store, ref).raw))

// What a job's own page adds to its row in the list.
const JOB_PAGE_ONLY = ['ancestors', 'executionBlocker', 'scheduledRetry', 'blockedBy', 'blocks', 'relatedWork', 'referencedIssueIdentifiers', 'planDocument', 'documentSummaries', 'legacyPlanDocument', 'project', 'goal', 'mentionedProjects', 'currentExecutionWorkspace', 'workProducts', 'linkedCases', 'externalChannelBinding', 'createdFrom']
// And what a chat, which is the bare job, leaves out on top of that.
const CHAT_LEAVES_OUT = [...JOB_PAGE_ONLY, 'externalConversationState', 'labels', 'labelIds', 'watchdog', 'blockerAttention', 'reviewAttention', 'successfulRunHandoff', 'activeRecoveryAction']

/** A job as the list shows it. Kept from the list when the import saw it there, made from its page otherwise. */
function listed(row) {
  if (row.list_raw) return JSON.parse(row.list_raw)
  const page = unpack(row.raw)
  const description = typeof page.description === 'string' ? Array.from(page.description) : null
  return {
    ...omit(page, JOB_PAGE_ONLY),
    description: description ? description.slice(0, JOB_LIST_DESCRIPTION).join('') : page.description ?? null,
    descriptionTruncated: description ? description.length > JOB_LIST_DESCRIPTION : false,
    activeRun: null,
    lastActivityAt: row.last_activity_at,
  }
}

/** The shortest shape of a job: what `view=compact` gives. */
export function compact(issue) {
  const out = {}
  out.externalConversationState = issue.externalConversationState ?? null
  for (const key of ['id', 'companyId', 'projectId', 'projectWorkspaceId', 'goalId', 'parentId', 'visibility', 'privacyRootIssueId', 'title', 'description', 'status', 'workMode', 'priority', 'reviewPolicy', 'assigneeAgentId', 'assigneeUserId', 'checkoutRunId', 'executionRunId', 'executionAgentNameKey', 'executionLockedAt', 'createdByAgentId', 'createdByUserId', 'issueNumber', 'identifier', 'originKind', 'originId', 'originRunId', 'requestDepth', 'billingCode', 'executionWorkspaceId', 'startedAt', 'completedAt', 'cancelledAt', 'createdAt', 'updatedAt']) out[key] = issue[key]
  for (const key of ['labelIds', 'labels', 'blockedBy', 'blockerAttention', 'reviewAttention', 'scheduledRetry']) if (issue[key]) out[key] = issue[key]
  for (const key of ['blockedInboxAttention', 'liveDescendantCount', 'myLastTouchAt', 'lastExternalCommentAt', 'lastActivityAt', 'isUnreadForMe']) if (issue[key] !== undefined) out[key] = issue[key]
  out.activeRecoveryAction = issue.activeRecoveryAction ?? null
  out.successfulRunHandoff = issue.successfulRunHandoff ?? null
  return out
}

const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 }
const rank = (priority) => PRIORITY[priority] ?? 4
const backwards = (a, b) => (a < b ? 1 : a > b ? -1 : 0)

/** How many single-letter edits turn one word into the other, giving up past `most`. */
function editDistance(a, b, most) {
  const s = Array.from(a)
  const t = Array.from(b)
  if (Math.abs(s.length - t.length) > most) return most + 1
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i += 1) {
    const next = [i]
    let best = i
    for (let j = 1; j <= t.length; j += 1) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1))
      if (next[j] < best) best = next[j]
    }
    if (best > most) return most + 1
    prev = next
  }
  return prev[t.length]
}

const FILLER = new Set(['a', 'an', 'the', 'and', 'of', 'to', 'for', 'in', 'on', 'with'])
const escapeRegex = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of a search: quoted phrases kept whole, filler dropped. */
export function searchWords(query) {
  const normalized = String(query).slice(0, SEARCH_MAX_CHARS).trim().replace(/\s+/g, ' ').toLowerCase()
  const parsed = Array.from(normalized.matchAll(/"([^"]+)"|([^\s"]+)/g), (m) => ({ text: m[1] ?? m[2], quoted: m[1] !== undefined }))
  const meaningful = parsed.filter((term) => term.quoted || !FILLER.has(term.text))
  const unique = new Map()
  for (const term of meaningful.length ? meaningful : parsed) unique.set(term.text, { ...term, quoted: term.quoted || unique.get(term.text)?.quoted === true })
  const terms = [...unique.values()].slice(0, SEARCH_MAX_WORDS)
  const tokens = terms.map((term) => term.text)
  const code = /^([a-z][a-z0-9]*)[- ](\d+)$/i.exec(normalized) ?? /^([a-z]+)(\d+)$/i.exec(normalized)
  return { normalized, terms, tokens, phrase: tokens.join(' '), code: code ? `${code[1]}-${code[2]}` : normalized }
}

/**
 * Search the job list: a job matches when every word is found somewhere in its
 * title, code, description, comments or documents; a typed job code matches that job. Each match gets
 * a score in bands that cannot overtake each other (the code, the whole title, the title's words, the
 * job's own text, then anything under it). When nothing matches, close spellings of the title do.
 */
function searchScores(store, rows, query, passes) {
  const search = searchWords(query)
  const n = search.tokens.length
  if (!n) return new Map()
  const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null)
  // A word of one to three letters has to start a word: "ui" is not found in "build".
  const starts = search.tokens.map((token) => (/^[\p{L}]{1,3}$/u.test(token) ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(token)}`, 'iu') : null))
  const has = (field, i) => field !== null && field.includes(search.tokens[i]) && (!starts[i] || starts[i].test(field))
  const wordOf = search.tokens.map((token) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(token)}($|[^\\p{L}\\p{N}_])`, 'iu'))
  const under = (sql) => {
    const found = search.tokens.map(() => new Set())
    for (const row of store.rows(sql)) {
      const fields = [lower(row.a), lower(row.b)]
      search.tokens.forEach((_, i) => { if (fields.some((f) => has(f, i))) found[i].add(row.job_id) })
    }
    return found
  }
  const inComments = under('SELECT job_id, body AS a, NULL AS b FROM comments WHERE deleted_at IS NULL')
  const inDocuments = under('SELECT d.job_id AS job_id, b.title AS a, b.body AS b FROM job_documents d JOIN documents b ON b.id = d.document_id')
  const count = (flags) => flags.filter(Boolean).length

  const flagsOf = (row) => {
    const title = lower(row.title) ?? ''
    const code = lower(row.identifier)
    const description = lower(row.description)
    const titleTerms = search.tokens.map((_, i) => has(title, i))
    const issueTerms = search.tokens.map((_, i) => titleTerms[i] || has(code, i) || has(description, i))
    const allTerms = search.tokens.map((_, i) => issueTerms[i] || inComments[i].has(row.id) || inDocuments[i].has(row.id))
    return {
      titleTerms,
      identExact: code === search.code,
      identStarts: code !== null && code.startsWith(search.code),
      titleExact: title === search.phrase,
      titleStarts: title.startsWith(search.phrase),
      titlePhrase: title.includes(search.phrase),
      titleCoverage: count(titleTerms),
      titleWordCoverage: count(wordOf.map((re) => re.test(row.title ?? ''))),
      issueCoverage: count(issueTerms),
      tokenCoverage: count(allTerms),
    }
  }
  const scoreOf = (row, f, fuzzy) => {
    const band = f.identExact ? 8000 : f.identStarts ? 7000 : f.titleExact ? 6000 : f.titlePhrase && f.titleCoverage === n ? 5000 : f.titleCoverage === n ? 4000
      : f.issueCoverage === n ? 3000 : f.tokenCoverage === n ? 2000 : fuzzy ? 1000 : 0
    return band + f.titleWordCoverage * 10 + (f.titleStarts ? 30 : 0) + (row.status === 'done' || row.status === 'cancelled' ? 0 : 10)
  }

  const scores = new Map()
  const flags = new Map(rows.map((row) => [row.id, flagsOf(row)]))
  for (const row of rows) {
    const f = flags.get(row.id)
    if (f.tokenCoverage === n || f.identExact || f.identStarts) scores.set(row.id, scoreOf(row, f, false))
  }
  // Close spellings are tried only when the exact words found nothing the list would show.
  const anyShown = rows.some((row) => scores.has(row.id) && passes(row))
  const fuzzyAllowed = !search.terms.some((term) => term.quoted) && search.terms.some((term) => /^[\p{L}]{4,255}$/u.test(term.text)) && !/^[a-z][a-z0-9]*[- ]?\d+$/i.test(search.normalized)
  if (!anyShown && fuzzyAllowed) {
    for (const row of rows) {
      const f = flags.get(row.id)
      if (f.titleCoverage === n) continue
      const words = (row.title ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
      const close = search.terms.every((term, i) => {
        if (f.titleTerms[i]) return true
        if (!/^[\p{L}]{4,255}$/u.test(term.text)) return false
        const length = Array.from(term.text).length
        return words.some((word) => {
          const size = Array.from(word).length
          if (size < 4 || size > 255) return false
          const edits = Math.min(size, length) >= 6 ? 2 : Math.min(size, length) >= 5 ? 1 : 0
          return Math.abs(size - length) <= edits && editDistance(term.text, word, edits) <= edits
        })
      })
      if (close) scores.set(row.id, scoreOf(row, f, true))
    }
  }
  return scores
}

/** A job the lists show: not a chat (unless words are searched), not a plugin's own operation. */
const listable = (row, q) => !(!q && row.conversation_agent_id) && !/^plugin:.*:operation(:.*)?$/.test(row.origin_kind || '')

/** When a done or cancelled job was settled, as its stamp. */
const settledAt = (row) => (row.status === 'cancelled' ? row.cancelled_at || row.updated_at : row.completed_at || row.updated_at) || ''

/**
 * GET /companies/:id/issues. Filters in use: limit, offset, status (one or a comma list), projectId,
 * assigneeAgentId (an id or "null"), parentId, q, view=compact, settledSince (an ISO time: only jobs done or
 * cancelled since then). Chats and hidden jobs are left out; a search looks through chats too.
 */
export function jobs(store, companyId, query = {}) {
  const { limit: rawLimit, offset: rawOffset, view } = query
  if (view !== undefined && view !== 'compact') throw new Refused(400, "view must be 'compact' when provided")
  const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit) ? Number.parseInt(rawLimit, 10) : null
  if (rawLimit !== undefined && (parsedLimit === null || parsedLimit <= 0)) throw new Refused(400, `limit must be a positive integer up to ${JOB_LIST_MAX}`)
  const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset) ? Number.parseInt(rawOffset, 10) : null
  if (rawOffset !== undefined && parsedOffset === null) throw new Refused(400, 'offset must be a non-negative integer')
  const limit = parsedLimit === null ? JOB_LIST_DEFAULT : parsedLimit > JOB_LIST_MAX ? Number.MAX_SAFE_INTEGER : parsedLimit // above the page max means "all" (crew scripts ask limit=100000)
  const offset = parsedOffset ?? 0

  let assignee
  if (query.assigneeAgentId !== undefined) {
    const wanted = String(query.assigneeAgentId).trim()
    if (!wanted) assignee = undefined
    else if (wanted.toLowerCase() === 'null') assignee = null
    else if (ID.test(wanted)) assignee = wanted.toLowerCase()
    else throw new Refused(422, "assigneeAgentId must be a UUID or 'null'")
  }
  const statuses = String(query.status ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const q = String(query.q ?? '').trim()
  const parentId = query.parentId ?? query.parentIssueId
  const settledSince = sinceOf(query.settledSince)

  const where = ['company_id = ?', 'hidden_at IS NULL', 'harness_kind IS NULL']
  const params = [companyId]
  const rows = store.rows(`SELECT id, identifier, title, description, status, priority, parent_id, project_id, assignee_agent_id, conversation_agent_id, origin_kind, updated_at, last_activity_at, completed_at, cancelled_at, list_raw FROM jobs WHERE ${where.join(' AND ')}`, ...params)
  // The filters a job has to pass to be listed at all.
  const passes = (row) => {
    if (!listable(row, q)) return false
    if (statuses.length && !statuses.includes(row.status)) return false
    if (settledSince && !(['done', 'cancelled'].includes(row.status) && settledAt(row) >= settledSince)) return false
    if (assignee === null && row.assignee_agent_id) return false
    if (assignee && row.assignee_agent_id !== assignee) return false
    if (query.projectId && row.project_id !== query.projectId) return false
    if (parentId && row.parent_id !== parentId) return false
    return true
  }
  const scores = q ? searchScores(store, rows, q, passes) : null
  const shown = rows.filter((row) => passes(row) && (!scores || scores.has(row.id)))
  shown.sort((a, b) => (scores ? scores.get(b.id) - scores.get(a.id) : 0)
    || rank(a.priority) - rank(b.priority)
    || backwards(a.last_activity_at ?? '', b.last_activity_at ?? '')
    || backwards(a.updated_at ?? '', b.updated_at ?? '')
    || backwards(a.id, b.id))
  const page = shown.slice(offset, offset + limit).map((row) => listed(row.list_raw ? row : store.row('SELECT * FROM jobs WHERE id = ?', row.id)))
  return view === 'compact' ? page.map(compact) : page
}

/** An ISO time from a query, or '' when none was asked for. */
function sinceOf(value) {
  if (value === undefined || value === '') return ''
  const at = Date.parse(String(value))
  if (!Number.isFinite(at)) throw new Refused(400, 'settledSince must be an ISO time')
  return new Date(at).toISOString()
}

/**
 * GET /companies/:id/job-counts[?since=ISO&projectId=&assigneeAgentId=]: how many jobs the lists hold in each state, and how many
 * were done and cancelled since a time (the start of today, say). The same jobs as the list: no chats, nothing hidden.
 */
export function jobCounts(store, companyId, query = {}) {
  const since = sinceOf(query.since)
  const statuses = {}
  const settled = { done: 0, cancelled: 0 }
  for (const row of store.rows('SELECT status, project_id, assignee_agent_id, conversation_agent_id, origin_kind, updated_at, completed_at, cancelled_at FROM jobs WHERE company_id = ? AND hidden_at IS NULL AND harness_kind IS NULL', companyId)) {
    if (!listable(row, '') || (query.projectId && row.project_id !== query.projectId)) continue
    if (query.assigneeAgentId && row.assignee_agent_id !== query.assigneeAgentId) continue
    statuses[row.status] = (statuses[row.status] || 0) + 1
    if (since && row.status in settled && settledAt(row) >= since) settled[row.status] += 1
  }
  return { statuses, since, settled }
}

/** GET /issues/:id/comments: newest first, or oldest first with order=asc; `limit` keeps the first so many. */
export function comments(store, ref, query = {}) {
  const found = jobOr404(store, ref)
  const asc = String(query.order ?? '').trim().toLowerCase() === 'asc'
  const wanted = typeof query.limit === 'string' && query.limit.trim() ? Number(query.limit) : null
  const limit = wanted && Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), COMMENT_LIST_MAX) : null
  // By when each was written: a job brought over from the old engine kept its comments numbered newest first,
  // so the number alone does not say which came last.
  const way = asc ? 'ASC' : 'DESC'
  const all = store.objects(`SELECT raw FROM comments WHERE job_id = ? ORDER BY created_at ${way}, position ${way}`, found.id)
  return limit ? all.slice(0, limit) : all
}

export const cards = (store, ref) => store.objects('SELECT raw FROM cards WHERE job_id = ? ORDER BY position', jobOr404(store, ref).id).map(cardAsRead)

// Documents an engine writes for itself. They are read by name and searched, but not listed unless asked for.
const SYSTEM_DOCUMENTS = new Set(['continuation-summary', 'pipeline-case-body'])

/** GET /issues/:id/documents[?includeSystem=true], in the order of their names. */
export function documents(store, ref, query = {}) {
  const all = store.objects('SELECT d.raw AS raw FROM job_documents j JOIN documents d ON d.id = j.document_id WHERE j.job_id = ? ORDER BY j.position', jobOr404(store, ref).id)
  return query.includeSystem === 'true' ? all : all.filter((d) => !SYSTEM_DOCUMENTS.has(d.key))
}

function documentLink(store, ref, key) {
  const found = jobOr404(store, ref)
  const link = store.row('SELECT document_id FROM job_documents WHERE job_id = ? AND key = ?', found.id, String(key).trim().toLowerCase())
  if (!link) throw missing('Document')
  return link.document_id
}

export const document = (store, ref, key) => store.object('SELECT raw FROM documents WHERE id = ?', documentLink(store, ref, key))

export const documentRevisions = (store, ref, key) => store.objects('SELECT raw FROM document_versions WHERE document_id = ? ORDER BY position', documentLink(store, ref, key))

export const attachments = (store, ref) => store.objects('SELECT raw FROM attachments WHERE job_id = ? ORDER BY position', jobOr404(store, ref).id)

/**
 * A job's runs in the order they were linked, each with how it went: a job's page shows who ran, how it ended, how long
 * it took and what it used. The link row holds only the run's id, so the run itself is read beside it.
 */
export function jobRuns(store, ref) {
  const links = store.objects('SELECT raw FROM job_runs WHERE job_id = ? ORDER BY position', jobOr404(store, ref).id)
  return links.map((link) => {
    const run = link.runId ? store.object('SELECT raw FROM runs WHERE id = ?', link.runId) : null
    if (!run) return link
    return { ...link, status: run.status, agentId: run.agentId, invocationSource: run.invocationSource, startedAt: run.startedAt, finishedAt: run.finishedAt, createdAt: run.createdAt, error: run.error, errorCode: run.errorCode, usageJson: run.usageJson }
  })
}

// ───────── chats ─────────

const chatOf = (page) => omit(page, CHAT_LEAVES_OUT)

/** GET /companies/:id/chats: the owner's chats with bots, the one last touched first. */
export const chats = (store, companyId) => store.objects('SELECT raw FROM jobs WHERE company_id = ? AND conversation_user_id = ? AND conversation_agent_id IS NOT NULL ORDER BY updated_at DESC, id ASC', companyId, OWNER).map(chatOf)

/** GET /companies/:id/chats/:agent: the chat with one bot, or null when none was started. */
export function chat(store, companyId, agentRef) {
  const bot = agentRow(store, agentRef, companyId)
  if (!bot) throw missing('Agent')
  const found = store.object('SELECT raw FROM jobs WHERE company_id = ? AND conversation_agent_id = ? AND conversation_user_id = ? LIMIT 1', companyId, bot.id, OWNER)
  return found ? chatOf(found) : null
}

// ───────── runs ─────────

/** What the full run list keeps of a run's result: its closing words, cut short, and its cost. */
function resultSummary(result) {
  if (!result || typeof result !== 'object') return null
  const out = {}
  for (const key of ['summary', 'result', 'message', 'error']) {
    const value = typeof result[key] === 'string' ? Array.from(result[key]).slice(0, RESULT_WORDS).join('') : ''
    if (value.trim()) out[key] = value
  }
  for (const key of ['total_cost_usd', 'cost_usd', 'costUsd']) {
    const value = result[key]
    if (value === null || value === undefined || typeof value === 'object') continue
    const parsed = Number(String(value).trim())
    if (String(value).trim() && Number.isFinite(parsed)) out[key] = parsed
  }
  return Object.keys(out).length ? out : null
}

// What the short run list blanks out and the full one keeps.
const RUN_LIST_KEEPS = ['usageJson', 'sessionIdBefore', 'sessionIdAfter', 'logStore', 'logRef', 'logSha256', 'externalRunId', 'processPid', 'processGroupId']

const numberText = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : String(value))
const RUN_ROW = ['id', 'responsibleUserId', 'companyId', 'agentId', 'scopeKind', 'issueId', 'invocationSource', 'triggerDetail', 'status', 'startedAt', 'finishedAt', 'error', 'wakeupRequestId', 'exitCode', 'signal', 'logBytes', 'logCompressed', 'errorCode', 'processStartedAt', 'lastOutputAt', 'lastOutputSeq', 'lastOutputStream', 'lastOutputBytes', 'retryOfRunId', 'processLossRetryCount', 'scheduledRetryAt', 'scheduledRetryAttempt', 'scheduledRetryReason', 'livenessState', 'livenessReason', 'continuationAttempt', 'lastUsefulActionAt', 'nextAction', 'createdAt', 'updatedAt']
const CONTEXT_ROW = ['issueId', 'taskId', 'taskKey', 'commentId', 'wakeCommentId', 'wakeReason', 'wakeSource', 'wakeTriggerDetail']

/**
 * A run's row in the short list, made from its page: for a run Botyard started itself, which was never
 * in a list kept from elsewhere. Token counts are text there, and what is large or private is blank.
 */
function shortRun(page) {
  const out = {}
  for (const key of RUN_ROW) out[key] = page[key] ?? null
  out.inputTokens = numberText(page.usageJson?.inputTokens)
  out.cachedInputTokens = numberText(page.usageJson?.cachedInputTokens)
  out.outputTokens = numberText(page.usageJson?.outputTokens)
  out.totalTokens = numberText(page.usageJson?.totalTokens)
  out.costUsd = numberText(page.resultJson?.costUsd ?? page.resultJson?.cost_usd ?? page.resultJson?.total_cost_usd)
  for (const key of [...RUN_LIST_KEEPS, 'stdoutExcerpt', 'stderrExcerpt', 'resultJson']) out[key] = null
  const context = {}
  for (const key of CONTEXT_ROW) if (typeof page.contextSnapshot?.[key] === 'string' && page.contextSnapshot[key].trim()) context[key] = page.contextSnapshot[key]
  if (!context.issueId && page.issueId) context.issueId = page.issueId
  out.contextSnapshot = Object.keys(context).length ? context : null
  return out
}

/** GET /companies/:id/heartbeat-runs?agentId&limit&summary: runs, the newest first. */
export function runs(store, companyId, query = {}) {
  const limit = query.limit ? Math.max(1, Math.min(RUN_LIST_MAX, Number.parseInt(query.limit, 10) || 200)) : null
  const summary = query.summary === 'true' || query.summary === '1'
  const where = ['company_id = ?']
  const params = [companyId]
  if (query.agentId) {
    where.push('agent_id = ?')
    params.push(query.agentId)
  }
  const rows = store.rows(`SELECT summary_raw, CASE WHEN summary_raw IS NULL OR ? THEN raw END AS raw FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`, summary ? 0 : 1, ...(limit ? [...params, limit] : params))
  return rows.map((row) => {
    const page = row.raw ? unpack(row.raw) : null
    const short = row.summary_raw ? JSON.parse(row.summary_raw) : shortRun(page)
    if (summary) return short
    const out = { ...short }
    for (const key of RUN_LIST_KEEPS) out[key] = page[key] ?? null
    out.resultJson = resultSummary(page.resultJson)
    return out
  })
}

export function run(store, id) {
  const raw = String(id ?? '')
  if (raw !== raw.trim() || !ID.test(raw)) throw new Refused(400, 'Invalid heartbeat run ID')
  const found = store.object('SELECT raw FROM runs WHERE id = ?', raw.toLowerCase())
  if (!found) throw missing('Heartbeat run')
  return found
}

const liveLimit = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(LIVE_RUN_MAX, Math.trunc(parsed)) : fallback
}

/**
 * GET /companies/:id/live-runs: the runs going on right now.
 */
export const liveRuns = (store, companyId, query = {}) => store.rows(`SELECT live_raw, CASE WHEN live_raw IS NULL THEN raw END AS raw FROM runs WHERE company_id = ? AND status IN ${LIVE} ORDER BY created_at DESC LIMIT ?`, companyId, liveLimit(query.limit, LIVE_RUN_MAX)).map((row) => liveRow(store, row))

const LIVE_ROW = ['id', 'runtimeMode', 'companyId', 'status', 'invocationSource', 'triggerDetail', 'startedAt', 'finishedAt', 'createdAt', 'agentId', 'logBytes', 'livenessState', 'livenessReason', 'continuationAttempt', 'lastUsefulActionAt', 'nextAction', 'lastOutputAt', 'lastOutputSeq', 'lastOutputStream', 'lastOutputBytes', 'processStartedAt', 'scopeKind', 'issueId']

/** A live run's row: the one kept with the run when there is one, else made from its page and its bot. */
function liveRow(store, row) {
  if (row.live_raw) return JSON.parse(row.live_raw)
  const page = unpack(row.raw)
  const bot = store.object('SELECT raw FROM agents WHERE id = ?', page.agentId ?? '') || {}
  const short = shortRun(page)
  const out = {}
  for (const key of LIVE_ROW) out[key] = page[key] ?? null
  return {
    ...out, contextCommentId: short.contextSnapshot?.commentId ?? null, contextWakeCommentId: short.contextSnapshot?.wakeCommentId ?? null,
    agentName: bot.name ?? null, agentAppearance: bot.appearance ?? null, adapterType: bot.adapterType ?? null,
    inputTokens: short.inputTokens, cachedInputTokens: short.cachedInputTokens, outputTokens: short.outputTokens, totalTokens: short.totalTokens, costUsd: short.costUsd,
    avatarUrl: bot.avatarUrl ?? null, execution: page.execution ?? null, outputSilence: page.outputSilence ?? null,
  }
}

// A job's own live runs are the same rows without what names the company, the job and the tokens.
const JOB_LIVE_LEAVES_OUT = ['companyId', 'scopeKind', 'issueId', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'costUsd']

export function jobLiveRuns(store, ref) {
  const found = jobOr404(store, ref)
  return store.rows(`SELECT live_raw, CASE WHEN live_raw IS NULL THEN raw END AS raw FROM runs WHERE job_id = ? AND status IN ${LIVE} ORDER BY created_at DESC`, found.id).map((row) => omit(liveRow(store, row), JOB_LIVE_LEAVES_OUT))
}

// ───────── routines, work folders ─────────

/**
 * A routine with its timetables and its last run as they are now: the engine moves a timetable's
 * next time and adds runs without rewriting the routine's own page each time.
 */
function routineNow(store, routine) {
  const triggers = store.objects('SELECT raw FROM routine_triggers WHERE routine_id = ? ORDER BY rowid', routine.id)
  const last = store.objects('SELECT raw FROM routine_runs WHERE routine_id = ? AND triggered_at IS NOT NULL ORDER BY triggered_at DESC LIMIT 1', routine.id)[0]
  const out = { ...routine }
  if (triggers.length) out.triggers = triggers
  if (last && last.id !== routine.lastRun?.id && last.triggeredAt >= (routine.lastRun?.triggeredAt || '')) out.lastRun = last
  return out
}

export const routines = (store, companyId) => store.rows('SELECT list_raw, raw FROM routines WHERE company_id = ? ORDER BY position', companyId).map((row) => routineNow(store, JSON.parse(row.list_raw ?? row.raw)))

function routineOr404(store, id) {
  const found = ID.test(String(id)) ? store.row('SELECT id, raw FROM routines WHERE id = ?', String(id).toLowerCase()) : null
  if (!found) throw missing('Routine')
  return found
}

export const routine = (store, id) => routineNow(store, unpack(routineOr404(store, id).raw))

export const routineRuns = (store, id) => store.objects('SELECT raw FROM routine_runs WHERE routine_id = ? ORDER BY position', routineOr404(store, id).id)

export const routineRevisions = (store, id) => store.objects('SELECT raw FROM routine_revisions WHERE routine_id = ? ORDER BY position', routineOr404(store, id).id)

export function workspace(store, id) {
  const found = ID.test(String(id)) ? store.object('SELECT raw FROM workspaces WHERE id = ?', String(id).toLowerCase()) : null
  if (!found) throw missing('Execution workspace')
  return found
}

// ───────── tokens and cost ─────────

const SUBSCRIPTION = new Set(['subscription_included', 'subscription_overage'])
const METERED = 'metered_api'

/** The from and to of a cost question. With neither, it is the month so far. */
function costRange(query, now) {
  if (query.period !== undefined && query.period !== 'all' && query.period !== 'month') throw new Refused(400, "invalid 'period'")
  if (query.period === 'all') {
    if (query.from !== undefined || query.to !== undefined) throw new Refused(400, 'all-time period cannot have date bounds')
    return {}
  }
  const date = (value, name) => {
    if (value === undefined || value === '') return undefined
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) throw new Refused(400, `invalid '${name}' date`)
    return new Date(ms).toISOString()
  }
  const from = date(query.from, 'from')
  const to = date(query.to, 'to')
  if (from && to && from > to) throw new Refused(400, 'from must not be after to')
  if (from || to) return { from, to }
  const today = new Date(now)
  return { from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString(), to: today.toISOString() }
}

/** Add amounts written as decimal text without losing a digit, and write the sum the same way. */
function exactSum(amounts) {
  let scale = 0
  for (const amount of amounts) scale = Math.max(scale, (String(amount).split('.')[1] || '').length)
  let total = 0n
  for (const amount of amounts) {
    const [head, tail = ''] = String(amount).replace('-', '').split('.')
    const units = BigInt(head + tail.padEnd(scale, '0'))
    total += String(amount).startsWith('-') ? -units : units
  }
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0')
  return `${total < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`
}

/** One line of a cost summary, from the usage rows that fall under it. */
function tally(rows, { runs: withRuns = false, unpriced = false } = {}) {
  // Old Codex rows counted cached tokens inside the input; they are taken out again in the sum.
  const input = (row) => (row.receipt_hash === null && row.provider === 'openai' && !/^openai\/./.test(row.model || '') ? Math.max(0, (row.input_tokens || 0) - (row.cached_input_tokens || 0)) : row.input_tokens || 0)
  const sum = (pick, only = () => true) => rows.reduce((total, row) => total + (only(row) ? pick(row) : 0), 0)
  const exact = exactSum(rows.map((row) => row.cost_cents ?? '0'))
  const subscription = (row) => SUBSCRIPTION.has(row.billing_type)
  const distinctRuns = (only) => new Set(rows.filter((row) => only(row) && row.run_id).map((row) => row.run_id)).size
  const out = {
    eventCount: rows.length,
    estimatedEventCount: rows.filter((row) => row.cost_status === 'estimated').length,
    costCents: Number(exact),
    costCentsExact: exact,
    inputTokens: sum(input),
    cachedInputTokens: sum((row) => row.cached_input_tokens || 0),
    outputTokens: sum((row) => row.output_tokens || 0),
  }
  if (unpriced) out.unpricedEventCount = rows.filter((row) => row.cost_status === 'unpriced' && row.billing_type !== 'subscription_included').length
  if (withRuns) {
    out.apiRunCount = distinctRuns((row) => row.billing_type === METERED)
    out.subscriptionRunCount = distinctRuns(subscription)
    out.subscriptionCachedInputTokens = sum((row) => row.cached_input_tokens || 0, subscription)
    out.subscriptionInputTokens = sum(input, subscription)
    out.subscriptionOutputTokens = sum((row) => row.output_tokens || 0, subscription)
  }
  return out
}

function grouped(rows, keyOf) {
  const groups = new Map()
  for (const row of rows) {
    const key = JSON.stringify(keyOf(row))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.values()]
}
const dearestFirst = (a, b) => b.costCents - a.costCents

/**
 * GET /companies/:id/costs/by-agent | by-agent-model | by-provider | by-project, with from and to.
 * Summed from the usage rows.
 */
export function costs(store, companyId, kind, query = {}, now = Date.now()) {
  const { from, to } = costRange(query, now)
  const where = ['company_id = ?']
  const params = [companyId]
  if (from) { where.push('occurred_at >= ?'); params.push(from) }
  if (to) { where.push('occurred_at <= ?'); params.push(to) }
  const rows = store.rows(`SELECT run_id, agent_id, project_id, provider, biller, billing_type, model, cost_status, receipt_hash, input_tokens, cached_input_tokens, output_tokens, cost_cents FROM usage WHERE ${where.join(' AND ')}`, ...params)
  const bots = new Map(store.objects('SELECT raw FROM agents WHERE company_id = ?', companyId).map((a) => [a.id, a]))
  const face = (agentId) => {
    const bot = agentId ? bots.get(agentId) : null
    return { agentAppearance: agentId ? bot?.appearance ?? null : null, ...(agentId && bot?.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}) }
  }

  if (kind === 'by-agent') {
    return grouped(rows, (r) => r.agent_id).map((group) => {
      const agentId = group[0].agent_id
      const bot = bots.get(agentId)
      const { agentAppearance, ...avatar } = face(agentId)
      return { agentId, agentName: bot?.name ?? null, agentAppearance, agentStatus: bot?.status ?? null, ...tally(group, { runs: true }), ...avatar }
    }).sort(dearestFirst)
  }
  if (kind === 'by-agent-model') {
    const order = (r) => [r.provider, r.biller, r.billingType, r.model].map((v) => v ?? '').join('\u0000')
    return grouped(rows, (r) => [r.agent_id, r.provider, r.biller, r.billing_type, r.model]).map((group) => {
      const first = group[0]
      const { agentAppearance, ...avatar } = face(first.agent_id)
      return { agentId: first.agent_id, agentName: bots.get(first.agent_id)?.name ?? null, agentAppearance, provider: first.provider, biller: first.biller, billingType: first.billing_type, model: first.model, ...tally(group), ...avatar }
    }).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))
  }
  if (kind === 'by-provider') {
    return grouped(rows, (r) => [r.provider, r.biller, r.billing_type, r.model]).map((group) => {
      const first = group[0]
      const { eventCount, estimatedEventCount, costCents, costCentsExact, unpricedEventCount, ...rest } = tally(group, { runs: true, unpriced: true })
      return { provider: first.provider, biller: first.biller, billingType: first.billing_type, model: first.model, costCents, costCentsExact, eventCount, estimatedEventCount, unpricedEventCount, ...rest }
    }).sort(dearestFirst)
  }
  if (kind === 'by-project') {
    // A usage row that names no project belongs to the one project its run touched, if it touched one.
    const touched = new Map(store.rows(`SELECT a.run_id AS run_id, MIN(j.project_id) AS project_id FROM activity a JOIN jobs j ON a.entity_type = 'issue' AND a.entity_id = j.id
      WHERE a.run_id IS NOT NULL AND j.project_id IS NOT NULL AND j.company_id = ? GROUP BY a.run_id HAVING COUNT(DISTINCT j.project_id) = 1`, companyId).map((r) => [r.run_id, r.project_id]))
    const names = new Map(store.rows('SELECT id, name FROM projects WHERE company_id = ?', companyId).map((p) => [p.id, p.name]))
    const projectOf = (row) => {
      const id = row.project_id ?? (row.receipt_hash === null ? touched.get(row.run_id) ?? null : null)
      return id && names.has(id) ? id : null
    }
    return grouped(rows, projectOf).map((group) => {
      const projectId = projectOf(group[0])
      return { projectId, projectName: projectId ? names.get(projectId) : null, ...tally(group) }
    }).sort(dearestFirst)
  }
  throw new Refused(404, 'API route not found')
}
