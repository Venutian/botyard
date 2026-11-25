/**
 * What the engine changes: jobs, comments, cards, documents, bots' pause, and the wake queue.
 *
 * Each function takes the store and the body of its path, and gives back the object the path
 * answers with, in the shape the crew's scripts and the bots' own calls read. `actor` says who is
 * asking: the owner or a script (`{ user: 'local-board' }`), or a bot in a run (`{ agent, run }`).
 */
import { randomUUID } from 'node:crypto'
import { ownerOnly } from './caller.mjs'
import { askText, ownerOf } from './card-kind.mjs'

export class Refused extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const STATUSES = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'])
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low'])
const CARD_KINDS = new Set(['ask_user_questions', 'request_confirmation'])
const MOST_QUESTIONS = 10
const MOST_OPTIONS = 12
const SAY_QUESTIONS = 'A question card needs its questions, each with a prompt and at least one option to choose: '
  + '{"payload": {"questions": [{"id": "choice", "prompt": "Which way?", "selectionMode": "single", "options": [{"id": "a", "label": "This way (recommended)", "description": "What it costs."}, {"id": "b", "label": "That way"}]}]}}. '
  + 'To ask something with no choices, write it as a comment on the job instead.'

/**
 * A question card's questions in the one shape the owner's pages and the answers read: `payload.questions`,
 * each `{ id, prompt, selectionMode: 'single' | 'multi', required, options: [{ id, label, description }] }`.
 * It reads the shapes bots have sent too: the questions under `payload.questionSet`, and `answerMode`
 * ('single_select', 'multi_select') for `selectionMode`. Null when there is no question that can be answered.
 */
export function questionsOf(payload) {
  const given = Array.isArray(payload?.questions) ? payload.questions : Array.isArray(payload?.questionSet?.questions) ? payload.questionSet.questions : []
  const out = []
  for (const [n, q] of given.slice(0, MOST_QUESTIONS).entries()) {
    if (!q || typeof q !== 'object') return null
    const prompt = text(q.prompt ?? q.question ?? q.text, 2000).trim()
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, MOST_OPTIONS).map((o, i) => (typeof o === 'string' ? { label: o } : o || {}))
      .map((o, i) => ({ ...o, id: text(String(o.id ?? ''), 80).trim() || `option-${i + 1}`, label: text(o.label ?? o.title ?? '', 300).trim(), description: text(o.description ?? o.hint ?? '', 1000).trim() || null }))
      .filter((o) => o.label || o.freeText)
    if (!prompt || !options.some((o) => !o.freeText)) return null
    const mode = String(q.selectionMode ?? q.answerMode ?? '').toLowerCase()
    out.push({ ...q, id: text(String(q.id ?? ''), 80).trim() || `question-${n + 1}`, prompt, selectionMode: mode.startsWith('multi') ? 'multi' : 'single', required: q.required !== false, options })
  }
  return out.length ? out : null
}

/** A stored question card as the pages read it: an older shape is given in the one shape, nothing is rewritten. */
export function cardAsRead(card) {
  if (card?.kind !== 'ask_user_questions' || Array.isArray(card.payload?.questions)) return card
  const questions = questionsOf(card.payload)
  if (!questions) return card
  const { questionSet, ...rest } = card.payload
  return { ...card, payload: { ...rest, questions } }
}
const MAX_TEXT = 200_000
const iso = (now) => new Date(now).toISOString()
const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.slice(0, max) : '')

const jobOf = (store, id) => store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', id, id)
const agentOf = (store, id) => store.object('SELECT raw FROM agents WHERE id = ?', id)
const companyOf = (store) => store.object('SELECT raw FROM company LIMIT 1')
/** Whether a job can be given to this bot: it exists and was not removed. */
const canHave = (store, id) => { const bot = agentOf(store, id); return Boolean(bot) && bot.status !== 'terminated' }

/** The job, or the refusal when there is none. */
function jobOr404(store, id) {
  const job = jobOf(store, id)
  if (!job) throw new Refused(404, 'Issue not found')
  return job
}

export function note(store, action, entity, actor, details, now) {
  store.put('activity', {
    id: randomUUID(), action, entityType: entity.type, entityId: entity.id,
    actorType: actor?.agent ? 'agent' : 'user', actorId: actor?.agent || actor?.user || 'local-board',
    agentId: actor?.agent || null, runId: actor?.run || null, details: details || {}, createdAt: iso(now),
  })
}

// ── the wake queue ──────────────────────────────────────────────────────────────────

/**
 * Ask for a bot to be run on a job. A second ask for the same bot and job while the first still
 * waits is folded into it, so ten comments wake a bot once.
 */
export function wake(store, agentId, { issueId = null, source = 'on_demand', reason = 'on_demand', forceFreshSession = false, payload = {} } = {}, { now = Date.now(), actor } = {}) {
  const agent = agentOf(store, agentId)
  if (!agent) throw new Refused(404, 'Agent not found')
  if (agent.status === 'terminated') throw new Refused(409, 'This bot was removed')
  const waiting = store.objects("SELECT raw FROM wakes WHERE agent_id = ? AND status = 'queued'", agentId).find((w) => (w.payload?.issueId || null) === issueId)
  if (waiting) {
    const merged = { ...waiting, coalescedCount: (waiting.coalescedCount || 0) + 1, payload: { ...waiting.payload, forceFreshSession: waiting.payload?.forceFreshSession || forceFreshSession }, updatedAt: iso(now) }
    store.put('wakes', merged)
    return merged
  }
  const request = {
    id: randomUUID(), companyId: agent.companyId, agentId, source, reason, status: 'queued', coalescedCount: 0,
    payload: { ...payload, issueId, forceFreshSession: Boolean(forceFreshSession) },
    requestedByActorType: actor?.agent ? 'agent' : 'user', requestedByActorId: actor?.agent || actor?.user || 'local-board',
    runId: null, requestedAt: iso(now), claimedAt: null, finishedAt: null, error: null, createdAt: iso(now), updatedAt: iso(now),
  }
  store.put('wakes', request)
  return request
}

// ── jobs ────────────────────────────────────────────────────────────────────────────

/** The next job code: the studio's letters and the next number, stepping over any code already taken. */
function nextCode(store, company) {
  const letters = company.issuePrefix || 'STU'
  let n = (Number(company.issueCounter) || 0) + 1
  while (store.row('SELECT id FROM jobs WHERE identifier = ?', `${letters}-${n}`)) n += 1
  store.put('company', { ...company, issueCounter: n })
  return { issueNumber: n, identifier: `${letters}-${n}` }
}

export function createJob(store, companyId, body = {}, { now = Date.now(), actor } = {}) {
  const company = companyOf(store)
  if (!company || company.id !== companyId) throw new Refused(404, 'Company not found')
  const title = text(body.title, 500).trim()
  if (!title) throw new Refused(400, 'A job needs a title')
  if (body.projectId && !store.row('SELECT id FROM projects WHERE id = ?', body.projectId)) throw new Refused(400, 'That project is not in this studio')
  if (body.projectId && store.row('SELECT archived_at FROM projects WHERE id = ?', body.projectId).archived_at) throw new Refused(400, 'That project was put away. Bring it back first')
  if (body.assigneeAgentId && !canHave(store, body.assigneeAgentId)) throw new Refused(400, 'That bot is not in this studio')
  if (body.parentId && !jobOf(store, body.parentId)) throw new Refused(400, 'The parent job does not exist')
  const status = STATUSES.has(body.status) ? body.status : 'todo'
  // The commit or branch the job's own branch is cut from, when it is not the project's main line.
  const asked = body.baseRef ?? body.executionWorkspaceSettings?.workspaceStrategy?.baseRef ?? null
  if (asked !== null && (typeof asked !== 'string' || !/^[\w][\w./-]{0,199}$/.test(asked))) throw new Refused(400, 'The commit or branch to start from is written as git names it')
  const startFrom = asked || null
  const job = store.tx(() => {
    const code = nextCode(store, company)
    const made = {
      id: randomUUID(), companyId, projectId: body.projectId || null, parentId: body.parentId ? jobOf(store, body.parentId).id : null,
      title, description: text(body.description), status, priority: PRIORITIES.has(body.priority) ? body.priority : 'medium',
      assigneeAgentId: body.assigneeAgentId || null, assigneeUserId: null,
      createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board',
      ...code, originKind: actor?.agent ? 'agent' : 'manual', originRunId: actor?.run || null,
      assigneeAdapterOverrides: body.assigneeAdapterOverrides || null, executionWorkspaceId: null, startFrom,
      conversationAgentId: null, conversationUserId: null, conversationState: null, hiddenAt: null,
      blockedBy: [], blocks: [], labels: [], labelIds: [],
      startedAt: null, completedAt: status === 'done' ? iso(now) : null, cancelledAt: status === 'cancelled' ? iso(now) : null,
      createdAt: iso(now), updatedAt: iso(now),
    }
    store.put('jobs', made)
    note(store, 'issue.created', { type: 'issue', id: made.id }, actor, { identifier: made.identifier }, now)
    return made
  })
  // Giving a job to a bot is what starts it.
  if (job.assigneeAgentId && ['todo', 'in_progress'].includes(job.status)) wake(store, job.assigneeAgentId, { issueId: job.id, source: 'assignment', reason: 'issue_assigned' }, { now, actor })
  return job
}

/** Status, title, text, priority, project, who has it, what it waits on, a model for this job; a comment may ride along. */
export function patchJob(store, id, body = {}, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, id)
  const next = { ...job }
  if (body.title !== undefined) { const title = text(body.title, 500).trim(); if (!title) throw new Refused(400, 'A job needs a title'); next.title = title }
  if (body.description !== undefined) next.description = text(body.description)
  if (body.priority !== undefined) { if (!PRIORITIES.has(body.priority)) throw new Refused(400, 'Unknown priority'); next.priority = body.priority }
  if (body.projectId !== undefined) { if (body.projectId && !store.row('SELECT id FROM projects WHERE id = ?', body.projectId)) throw new Refused(400, 'That project is not in this studio'); next.projectId = body.projectId || null }
  // A job moved to another project leaves its old worktree behind: its execution workspace is
  // cleared, so the next run cuts a fresh worktree in the new project's repo, from the job's
  // startFrom. Not while a run is going on it.
  if (body.projectId !== undefined && body.projectId !== job.projectId) {
    const active = store.objects("SELECT raw FROM runs WHERE job_id = ? AND status IN ('running', 'queued')", job.id)
    if (!active.length) next.executionWorkspaceId = null
  }
  if (body.assigneeAdapterOverrides !== undefined) next.assigneeAdapterOverrides = body.assigneeAdapterOverrides || null
  if (body.blockedByIssueIds !== undefined) {
    const ids = Array.isArray(body.blockedByIssueIds) ? body.blockedByIssueIds.map(String) : []
    if (ids.includes(job.id)) throw new Refused(400, 'A job cannot wait on itself')
    next.blockedBy = ids.map((other) => jobOf(store, other)).filter(Boolean).map((j) => ({ id: j.id, identifier: j.identifier, title: j.title, status: j.status }))
  }
  const given = body.assigneeAgentId !== undefined && body.assigneeAgentId !== job.assigneeAgentId
  if (given) { if (body.assigneeAgentId && !canHave(store, body.assigneeAgentId)) throw new Refused(400, 'That bot is not in this studio'); next.assigneeAgentId = body.assigneeAgentId || null }
  // A chat with a bot is never closed: a bot that ends its run by closing its job would leave the owner
  // writing to a bot that is never woken again. A chat asked to close stays in progress.
  if (job.conversationAgentId && ['done', 'cancelled'].includes(body.status)) body = { ...body, status: 'in_progress' }
  if (body.status !== undefined && body.status !== job.status) {
    if (!STATUSES.has(body.status)) throw new Refused(400, 'Unknown status')
    next.status = body.status
    if (body.status === 'in_progress' && !next.startedAt) next.startedAt = iso(now)
    next.completedAt = body.status === 'done' ? iso(now) : null
    next.cancelledAt = body.status === 'cancelled' ? iso(now) : null
  }
  next.updatedAt = iso(now)
  store.tx(() => {
    store.put('jobs', next)
    note(store, 'issue.updated', { type: 'issue', id: job.id }, actor, { status: next.status !== job.status ? next.status : undefined }, now)
  })
  if (typeof body.comment === 'string' && body.comment.trim()) addComment(store, job.id, { body: body.comment }, { now, actor, quiet: true })
  // A job handed to another bot, or reopened, starts for whoever has it now.
  const reopened = ['todo'].includes(next.status) && ['done', 'cancelled', 'blocked', 'backlog'].includes(job.status)
  if (next.assigneeAgentId && (given || reopened) && ['todo', 'in_progress'].includes(next.status)) wake(store, next.assigneeAgentId, { issueId: job.id, source: 'assignment', reason: 'issue_assigned' }, { now, actor })
  // A job that was waiting on this one may go on.
  if (next.status === 'done' && job.status !== 'done') {
    for (const waiting of store.objects("SELECT raw FROM jobs WHERE status IN ('blocked', 'todo', 'in_progress')")) {
      if (!(waiting.blockedBy || []).some((b) => b.id === job.id)) continue
      const left = waiting.blockedBy.filter((b) => b.id !== job.id)
      store.put('jobs', { ...waiting, blockedBy: left, status: waiting.status === 'blocked' && !left.length ? 'todo' : waiting.status, updatedAt: iso(now) })
      if (!left.length && waiting.assigneeAgentId) wake(store, waiting.assigneeAgentId, { issueId: waiting.id, source: 'automation', reason: 'issue_assigned' }, { now, actor })
    }
  }
  return next
}

// ── comments ────────────────────────────────────────────────────────────────────────

/** Most files one comment may carry. */
export const MOST_FILES_PER_COMMENT = 6

/**
 * The files a comment names to carry: each one already uploaded to this same job and not yet tied to
 * other words. Anything else is refused, so a comment cannot take another job's file.
 */
function filesFor(store, job, ids) {
  if (ids === undefined || ids === null) return []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Refused(400, 'attachmentIds is a list of file ids')
  const wanted = [...new Set(ids)]
  if (wanted.length > MOST_FILES_PER_COMMENT) throw new Refused(400, `A message carries at most ${MOST_FILES_PER_COMMENT} files`)
  return wanted.map((id) => {
    const raw = store.object('SELECT raw FROM attachments WHERE id = ? AND job_id = ?', id, job.id)
    const position = store.row('SELECT position FROM attachments WHERE id = ?', id)?.position ?? 0
    if (!raw) throw new Refused(400, 'That file is not on this job. Upload it to the job first')
    if (raw.issueCommentId) throw new Refused(409, 'That file already belongs to another message')
    return { raw, position }
  })
}

export function addComment(store, jobId, body = {}, { now = Date.now(), actor, quiet = false } = {}) {
  const job = jobOr404(store, jobId)
  const said = text(body.body).trim()
  if (body.clientRequestId) {
    const before = store.objects('SELECT raw FROM comments WHERE job_id = ?', job.id).find((c) => c.clientRequestId === body.clientRequestId)
    if (before) return before
  }
  const files = filesFor(store, job, body.attachmentIds)
  if (!said && !files.length) throw new Refused(400, 'Write something first')
  const position = store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM comments WHERE job_id = ?', job.id).n
  const comment = {
    id: randomUUID(), companyId: job.companyId, issueId: job.id, body: said,
    authorAgentId: actor?.agent || null, authorUserId: actor?.agent ? null : actor?.user || 'local-board', authorType: actor?.agent ? 'agent' : 'user',
    createdByRunId: actor?.run || null, clientRequestId: body.clientRequestId || null, origin: 'comment', metadata: {}, deletedAt: null,
    createdAt: iso(now), updatedAt: iso(now),
  }
  // A chat closed before chats could not be closed is opened again by the next word in it.
  const chat = Boolean(job.conversationAgentId)
  const reopen = chat && ['done', 'cancelled'].includes(job.status)
  store.tx(() => {
    store.put('comments', comment, { position })
    // Each file is tied to the words it came with, so the bot is shown it beside them.
    for (const file of files) store.put('attachments', { ...file.raw, issueCommentId: comment.id, updatedAt: iso(now) }, { position: file.position })
    store.put('jobs', { ...job, ...(reopen ? { status: 'in_progress', completedAt: null, cancelledAt: null } : {}), updatedAt: iso(now), lastActivityAt: iso(now) })
  })
  // Words from anyone but the bot that has the job wake that bot, unless the job is closed. A chat is never closed.
  const closed = !chat && ['done', 'cancelled'].includes(job.status)
  if (!quiet && job.assigneeAgentId && job.assigneeAgentId !== actor?.agent && !closed) wake(store, job.assigneeAgentId, { issueId: job.id, source: 'automation', reason: 'issue_commented', payload: { commentId: comment.id } }, { now, actor })
  return comment
}

// ── cards ───────────────────────────────────────────────────────────────────────────

export function createCard(store, jobId, body = {}, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, jobId)
  if (!CARD_KINDS.has(body.kind)) throw new Refused(400, 'A card is ask_user_questions or request_confirmation')
  const sent = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {}
  let payload = sent
  if (body.kind === 'ask_user_questions') {
    // The owner answers what is on the card: a card with nothing to choose from is refused before it reaches them.
    const questions = questionsOf(sent)
    if (!questions) throw new Refused(400, SAY_QUESTIONS)
    const { questionSet, ...rest } = sent
    payload = { version: 1, ...rest, questions }
  }
  if (body.idempotencyKey) {
    const before = store.objects('SELECT raw FROM cards WHERE job_id = ?', job.id).find((c) => c.idempotencyKey === body.idempotencyKey)
    if (before) return before
  }
  // The same question asked again on a job while it still waits is the card already there, counted, not a second one.
  const asking = askText({ kind: body.kind, title: text(body.title, 500), summary: text(body.summary, 4000), payload })
  const open = asking ? store.objects("SELECT raw FROM cards WHERE job_id = ? AND status = 'pending'", job.id).find((c) => c.kind === body.kind && askText(c) === asking) : null
  if (open) {
    const again = { ...open, asked: (open.asked || 1) + 1, lastAskedAt: iso(now), updatedAt: iso(now) }
    store.put('cards', again, { position: store.row('SELECT position FROM cards WHERE id = ?', open.id).position })
    return again
  }
  const position = store.row('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM cards WHERE job_id = ?', job.id).n
  const card = {
    id: randomUUID(), companyId: job.companyId, issueId: job.id, kind: body.kind, status: 'pending',
    continuationPolicy: body.continuationPolicy || 'wake_assignee', requestedResolverPolicy: body.resolverPolicy || 'human_only', resolverPolicy: body.resolverPolicy || 'human_only',
    idempotencyKey: body.idempotencyKey || null, title: text(body.title, 500) || null, summary: text(body.summary, 4000) || null,
    createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', sourceRunId: actor?.run || null,
    addresseeUserId: 'local-board', payload, result: null,
    resolvedByUserId: null, resolvedByAgentId: null, resolvedAt: null, createdAt: iso(now), updatedAt: iso(now),
    asked: 1, ...(body.ownerKind === 'must' ? { ownerKind: 'must', mustWhy: text(body.mustWhy, 200) } : {}),
  }
  // Its kind (must or default), the default answer and when that applies: card-kind.mjs.
  card.owner = ownerOf(card, now)
  store.put('cards', card, { position })
  note(store, 'issue.interaction_created', { type: 'issue', id: job.id }, actor, { kind: card.kind }, now)
  return card
}

const SETTLED = { accept: 'accepted', reject: 'rejected', respond: 'answered', withdraw: 'cancelled', cancel: 'cancelled' }

/** The owner answers a card, or the bot that asked takes it back. An answer wakes the bot that has the job. */
export function settleCard(store, jobId, cardId, verb, body = {}, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, jobId)
  const card = store.object('SELECT raw FROM cards WHERE id = ? AND job_id = ?', cardId, job.id)
  if (!card) throw new Refused(404, 'Interaction not found')
  if (!SETTLED[verb]) throw new Refused(404, 'API route not found')
  if (card.status !== 'pending') throw new Refused(409, 'This card was already settled')
  const takenBack = verb === 'withdraw' || verb === 'cancel'
  if (!takenBack) ownerOnly(actor, 'answers a card')
  if (verb === 'respond' && !(Array.isArray(body.answers) && body.answers.length)) throw new Refused(400, 'Answer the question first')
  if (verb === 'accept' && card.kind !== 'request_confirmation') throw new Refused(400, 'This card is a question: answer it')
  const position = store.row('SELECT position FROM cards WHERE id = ?', card.id).position
  const result = verb === 'respond' ? { answers: body.answers } : verb === 'reject' ? { outcome: 'rejected', reason: text(body.reason, 4000) || null } : verb === 'accept' ? { outcome: 'accepted' } : { outcome: 'withdrawn' }
  const settled = { ...card, status: SETTLED[verb], result, resolvedAt: iso(now), updatedAt: iso(now), resolvedByUserId: actor?.agent ? null : actor?.user || 'local-board', resolvedByAgentId: actor?.agent || null }
  store.put('cards', settled, { position })
  note(store, `issue.interaction_${SETTLED[verb]}`, { type: 'issue', id: job.id }, actor, { kind: card.kind }, now)
  if (!takenBack && card.continuationPolicy !== 'none' && job.assigneeAgentId && !['done', 'cancelled'].includes(job.status)) {
    wake(store, job.assigneeAgentId, { issueId: job.id, source: 'automation', reason: 'card_answered', payload: { interactionId: card.id } }, { now, actor })
  }
  return settled
}

// ── documents ───────────────────────────────────────────────────────────────────────

/** A job's document by its key, saved as a new version. */
export function putDocument(store, jobId, key, body = {}, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, jobId)
  const name = text(key, 120).trim()
  if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(name)) throw new Refused(400, 'A document key is letters, numbers and dashes')
  const link = store.row('SELECT document_id AS id FROM job_documents WHERE job_id = ? AND key = ?', job.id, name)
  const before = link ? store.object('SELECT raw FROM documents WHERE id = ?', link.id) : null
  if (body.baseRevisionId !== undefined && body.baseRevisionId !== null && body.baseRevisionId !== (before?.latestRevisionId || null)) throw new Refused(409, 'This document was changed since you opened it. Open it again and make your change there')
  if (typeof body.body !== 'string') throw new Refused(400, 'A document needs its text')
  const number = (before?.latestRevisionNumber || 0) + 1
  const revisionId = randomUUID()
  const doc = {
    ...(before || { id: randomUUID(), companyId: job.companyId, createdAt: iso(now) }),
    key: name, issueId: job.id, title: text(body.title, 300) || before?.title || name, format: body.format || before?.format || 'markdown',
    body: text(body.body), latestBody: text(body.body), latestRevisionId: revisionId, latestRevisionNumber: number, updatedAt: iso(now),
  }
  store.tx(() => {
    store.put('documents', doc)
    if (!link) store.put('job_documents', {}, { job_id: job.id, key: name, document_id: doc.id, position: store.row('SELECT COUNT(*) AS n FROM job_documents WHERE job_id = ?', job.id).n })
    store.put('document_versions', { id: revisionId, documentId: doc.id, issueId: job.id, key: name, revisionNumber: number, title: doc.title, format: doc.format, body: doc.body, changeSummary: text(body.changeSummary, 500) || null, createdByAgentId: actor?.agent || null, createdByUserId: actor?.agent ? null : actor?.user || 'local-board', createdAt: iso(now) }, { position: number })
  })
  return doc
}

/** Make an older version of a job's document the current one, as a new version: nothing is lost. */
export function restoreDocument(store, jobId, key, revisionId, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, jobId)
  const link = store.row('SELECT document_id AS id FROM job_documents WHERE job_id = ? AND key = ?', job.id, String(key).trim().toLowerCase())
  if (!link) throw new Refused(404, 'Document not found')
  const old = store.object('SELECT raw FROM document_versions WHERE id = ? AND document_id = ?', revisionId, link.id)
  if (!old) throw new Refused(404, 'Version not found')
  return putDocument(store, job.id, String(key).trim().toLowerCase(), { title: old.title, format: old.format, body: old.body || '', changeSummary: `Restored version ${old.revisionNumber}` }, { now, actor })
}

// ── bots ────────────────────────────────────────────────────────────────────────────

/** Pause or resume a bot. A paused bot's wakes wait in the queue; nothing is thrown away. */
export function setPaused(store, agentId, paused, { now = Date.now(), actor } = {}) {
  const agent = agentOf(store, agentId)
  if (!agent) throw new Refused(404, 'Agent not found')
  if (agent.status === 'terminated') throw new Refused(409, 'This bot was removed')
  const next = { ...agent, status: paused ? 'paused' : 'idle', pauseReason: paused ? 'manual' : null, pausedAt: paused ? iso(now) : null, updatedAt: iso(now) }
  store.put('agents', next)
  note(store, paused ? 'agent.paused' : 'agent.resumed', { type: 'agent', id: agentId }, actor, {}, now)
  return next
}

export { putAgent } from './bots.mjs'

/**
 * The owner's conversation with a bot: found, or made the first time. A conversation is a job with the
 * bot on the other end, so a message in it wakes the bot like any comment.
 */
export function openChat(store, companyId, agentId, { now = Date.now(), actor } = {}) {
  const agent = agentOf(store, agentId)
  if (!agent || agent.companyId !== companyId) throw new Refused(404, 'Agent not found')
  const found = store.objects('SELECT raw FROM jobs WHERE conversation_agent_id = ?', agentId)[0]
  if (found) return found
  const company = companyOf(store)
  return store.tx(() => {
    const made = {
      id: randomUUID(), companyId, projectId: null, parentId: null, title: `Chat with ${agent.name}`, description: '', status: 'in_progress', priority: 'medium',
      assigneeAgentId: agentId, assigneeUserId: null, createdByAgentId: null, createdByUserId: actor?.user || 'local-board', ...nextCode(store, company),
      originKind: 'conversation', conversationAgentId: agentId, conversationUserId: 'local-board', conversationState: 'open', hiddenAt: null, blockedBy: [], blocks: [], labels: [], labelIds: [],
      startedAt: iso(now), completedAt: null, cancelledAt: null, createdAt: iso(now), updatedAt: iso(now),
    }
    store.put('jobs', made)
    return made
  })
}

export { patchProject } from './projects.mjs'

/** Forget where a bot left off, so its next run on every job starts a fresh session. */
export function resetSessions(store, agentId, { now = Date.now(), actor } = {}) {
  if (!agentOf(store, agentId)) throw new Refused(404, 'Agent not found')
  const dropped = store.rows('SELECT id FROM sessions WHERE agent_id = ?', agentId).length
  store.remove('sessions', 'agent_id', agentId)
  note(store, 'agent.session_reset', { type: 'agent', id: agentId }, actor, { dropped }, now)
  return { ok: true, sessionsCleared: dropped }
}
