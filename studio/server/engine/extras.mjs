/**
 * The small paths around the edges: what a bot asks about its own job by itself, the things the
 * crew made that are not files (a pull request, a preview), the engine's own few settings, and the
 * calls for things a Botyard does not have (approvals, invites), which are answered in plain words
 * instead of "no such path".
 */
import { randomUUID } from 'node:crypto'
import { compact } from './read.mjs'
import { Refused, note, wake } from './write.mjs'

const iso = (now) => new Date(now).toISOString()
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
const jobOf = (store, ref) => store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', ref, String(ref).toUpperCase())
function jobOr404(store, ref) {
  const job = jobOf(store, ref)
  if (!job) throw new Refused(404, 'Issue not found')
  return job
}
const OPEN = ['todo', 'in_progress', 'in_review', 'blocked']

// ── what a bot asks by itself ───────────────────────────────────────────────────────

/** The jobs a bot has that are still open, shortest shape, the most urgent first. */
export function inbox(store, agentId) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 }
  return store.objects(`SELECT raw FROM jobs WHERE assignee_agent_id = ? AND hidden_at IS NULL AND status IN (${OPEN.map(() => '?').join(', ')})`, agentId, ...OPEN)
    .sort((a, b) => (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((job) => ({ ...compact(job), activeRun: null }))
}

/** A job with what a bot needs around it to start: the jobs above it, its project, and where its thread stands. */
export function jobContext(store, ref) {
  const job = jobOr404(store, ref)
  const line = (j) => ({ id: j.id, identifier: j.identifier, title: j.title, description: j.description ?? null, status: j.status, priority: j.priority, projectId: j.projectId ?? null, parentId: j.parentId ?? null, assigneeAgentId: j.assigneeAgentId ?? null, updatedAt: j.updatedAt })
  const ancestors = []
  for (let at = job.parentId ? jobOf(store, job.parentId) : null, n = 0; at && n < 20; at = at.parentId ? jobOf(store, at.parentId) : null, n++) ancestors.push(line(at))
  const project = job.projectId ? store.object('SELECT raw FROM projects WHERE id = ?', job.projectId) : null
  const last = store.row('SELECT id, created_at FROM comments WHERE job_id = ? AND deleted_at IS NULL ORDER BY position DESC LIMIT 1', job.id)
  return {
    issue: line(job), ancestors, goal: null,
    project: project ? { id: project.id, name: project.name, description: project.description ?? null, status: project.status } : null,
    commentCursor: { totalComments: store.row('SELECT COUNT(*) AS n FROM comments WHERE job_id = ? AND deleted_at IS NULL', job.id).n, latestCommentId: last?.id || null, latestCommentAt: last?.created_at || null },
    wakeComment: null,
  }
}

/** The jobs this one waits on, as they stand now. */
export function blockers(store, ref) {
  const job = jobOr404(store, ref)
  return (job.blockedBy || []).map((b) => { const now = jobOf(store, b.id); return now ? { id: now.id, identifier: now.identifier, title: now.title, status: now.status, priority: now.priority, assigneeAgentId: now.assigneeAgentId ?? null } : b })
}

/**
 * A bot "takes" or "lets go of" a job. The engine takes a job for a run when it starts the run, so
 * there is nothing more to do: the job is given back as it is. Taking a job another bot is running
 * on is refused.
 */
export function checkout(store, ref, body = {}, { actor } = {}) {
  const job = jobOr404(store, ref)
  const busy = store.objects("SELECT raw FROM runs WHERE job_id = ? AND status = 'running'", job.id).find((r) => actor?.agent && r.agentId !== actor.agent)
  if (busy) throw new Refused(409, 'Another bot is working on this job now')
  return job
}
export const release = (store, ref) => jobOr404(store, ref)

// ── things the crew made that are not files ─────────────────────────────────────────

const PRODUCT_TYPES = new Set(['pull_request', 'branch', 'commit', 'preview_url', 'artifact', 'document', 'runtime_service'])

/** POST /issues/:id/work-products: a pull request, a preview or another made thing, noted on its job. */
export function addProduct(store, ref, body = {}, { now = Date.now(), actor } = {}) {
  const job = jobOr404(store, ref)
  const title = text(body.title, 300).trim()
  if (!title) throw new Refused(400, 'Say what was made')
  if (body.url !== undefined && body.url !== null && !/^https?:\/\//i.test(String(body.url))) throw new Refused(400, 'A link starts with http:// or https://')
  const product = {
    id: randomUUID(), companyId: job.companyId, projectId: job.projectId || null, issueId: job.id, type: PRODUCT_TYPES.has(body.type) ? body.type : 'artifact', provider: text(body.provider, 60) || 'custom',
    externalId: text(body.externalId, 200) || null, title, url: body.url ? String(body.url).slice(0, 2000) : null, status: text(body.status, 40) || 'active', reviewState: text(body.reviewState, 40) || 'none',
    isPrimary: body.isPrimary === true, healthStatus: 'unknown', summary: text(body.summary, 4000) || null, metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
    createdByRunId: actor?.run || null, createdAt: iso(now), updatedAt: iso(now),
  }
  store.tx(() => {
    store.put('products', product)
    // The job's own page lists what was made on it.
    store.put('jobs', { ...job, workProducts: [...(job.workProducts || []), product], updatedAt: iso(now) })
    note(store, 'issue.work_product_created', { type: 'issue', id: job.id }, actor, { type: product.type }, now)
  })
  return product
}
export const products = (store, ref) => store.objects('SELECT raw FROM products WHERE job_id = ? ORDER BY created_at', jobOr404(store, ref).id)

// ── a sign-in card's "no" ───────────────────────────────────────────────────────────

/** The owner says no to a card that asked for a sign-in or a connection. The bot that asked is told. */
export function declineCard(store, cardId, body = {}, { now = Date.now(), actor } = {}) {
  const card = store.object('SELECT raw FROM cards WHERE id = ?', cardId)
  if (!card) throw new Refused(404, 'That card is not there')
  if (actor?.agent) throw new Refused(403, 'Only the owner answers a card')
  const job = jobOr404(store, card.issueId)
  if (card.status !== 'pending') throw new Refused(409, 'This card was already settled')
  const settled = { ...card, status: 'rejected', result: { outcome: 'declined', reason: text(body.reason, 4000) || null }, resolvedAt: iso(now), resolvedByUserId: actor?.user || 'local-board', updatedAt: iso(now) }
  store.put('cards', settled, { position: store.row('SELECT position FROM cards WHERE id = ?', card.id).position })
  if (job.assigneeAgentId && !['done', 'cancelled'].includes(job.status)) {
    try { wake(store, job.assigneeAgentId, { issueId: job.id, source: 'automation', reason: 'card_answered', payload: { interactionId: card.id } }, { now, actor }) } catch { /* the bot was removed */ }
  }
  return settled
}

// ── the engine's own few settings ───────────────────────────────────────────────────

const SETTINGS = new Set(['general', 'experimental'])

export function settings(store, which) {
  if (!SETTINGS.has(which)) throw new Refused(404, 'API route not found')
  try { return JSON.parse(store.meta(`settings:${which}`) || '{}') || {} } catch { return {} }
}

/** PATCH /instance/settings/:which: plain switches and values, kept as they are sent. */
export function patchSettings(store, which, body = {}, { actor } = {}) {
  if (actor?.agent) throw new Refused(403, 'Only the owner changes Botyard\'s settings')
  const next = { ...settings(store, which) }
  for (const [key, value] of Object.entries(body || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(key) || (value !== null && !['boolean', 'number', 'string'].includes(typeof value)) || String(value ?? '').length > 2000) throw new Refused(400, 'A setting is a name with a switch, a number or a short text')
    next[key] = value
  }
  store.setMeta(`settings:${which}`, JSON.stringify(next))
  return next
}

// ── what a Botyard does not have ─────────────────────────────────────────────────────

/** A Botyard has one person, its owner: there is nobody to invite and nothing waiting for approval. */
export const noInvites = () => { throw new Refused(409, 'A Botyard has one owner. Inviting people is not built') }
export const noSuch = (what) => () => { throw new Refused(404, `${what} not found`) }
