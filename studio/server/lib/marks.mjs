/**
 * Reviews from the owner's side: what can be marked on a job or in a chat, and the send.
 *
 * The PC page and the phone app both come through here, so they offer the same pieces in the same
 * order: the bot's last message first (so "review the last message" is one press from any job or
 * chat), then its earlier messages, the job's brief, its documents and its pictures. The send goes to
 * the engine's own review path with the owner's key; the engine refuses it from anyone else.
 */
import { EngineError, call, companyId } from './engine.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PICTURE = /^image\/(png|jpeg|webp|gif)$/
/** How many of a bot's earlier messages are offered besides the last one. */
const EARLIER = 8

const clip = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const firstLine = (text) => clip(String(text || '').split('\n').find((l) => l.trim())?.replace(/^[#>*\-\s]+/, '').trim() || '', 70)

/** The job a review is about: a job by id or code, or the chat with a bot. */
async function jobFor({ job, bot }, options) {
  if (bot) {
    if (!ID.test(bot)) throw new EngineError(400, 'That is not a bot id')
    const id = await companyId(options)
    const chat = await call(`/companies/${id}/chats/${bot}`, { ...options, method: 'POST', body: {} })
    return call(`/issues/${chat.id}`, options)
  }
  if (!job || !/^[\w-]{1,64}$/.test(job)) throw new EngineError(400, 'Say which job')
  return call(`/issues/${encodeURIComponent(job)}`, options)
}

/**
 * Everything on a job that can be marked, newest bot message first.
 * `picture` is the address the asking side shows a picture from (the page's file path or the phone's).
 */
export async function reviewSources(which = {}, { picture = (id) => `/api/studio/file?id=${id}`, ...options } = {}) {
  const job = await jobFor(which, options)
  const [comments, documents, files, agents, gate] = await Promise.all([
    call(`/issues/${job.id}/comments?order=asc`, options),
    call(`/issues/${job.id}/documents`, options).catch(() => []),
    call(`/issues/${job.id}/attachments`, options).catch(() => []),
    call(`/companies/${job.companyId}/agents`, options).catch(() => []),
    call(`/issues/${job.id}/gate`, options).catch(() => ({ gate: null })),
  ])
  const nameOf = new Map(agents.map((a) => [a.id, a.name]))
  const said = comments.filter((c) => c.authorAgentId && String(c.body || '').trim()).reverse()
  const pieces = []
  said.slice(0, EARLIER + 1).forEach((c, i) => pieces.push({
    id: `message:${c.id}`, kind: 'message', ref: c.id, at: c.createdAt,
    title: i === 0 ? `Last message from ${nameOf.get(c.authorAgentId) || 'the bot'}` : `${nameOf.get(c.authorAgentId) || 'Bot'}: ${firstLine(c.body)}`,
    text: c.body,
  }))
  if (String(job.description || '').trim()) pieces.push({ id: 'brief', kind: 'brief', ref: '', title: 'The brief', text: job.description })
  for (const d of documents) pieces.push({ id: `document:${d.key}`, kind: 'document', ref: d.key, title: d.title || d.key, text: d.body || '', at: d.updatedAt })
  for (const f of files.filter((f) => PICTURE.test(f.contentType || '')).reverse()) {
    if (/^mark-\d+-/.test(f.originalFilename || '')) continue
    pieces.push({ id: `picture:${f.id}`, kind: 'picture', ref: f.id, title: f.originalFilename || 'Picture', src: picture(f.id), at: f.createdAt })
  }
  return {
    jobId: job.id, ref: job.displayIdentifier || job.identifier || '', title: job.title || '', chat: Boolean(job.conversationAgentId),
    bot: nameOf.get(job.assigneeAgentId) || '', projectId: job.projectId || null, gate: gate?.gate || null, pieces,
  }
}

/** Send the owner's marks: one message to the job's bot, or the answer to the gate its trip waits at. */
export async function sendMarks(body = {}, options) {
  const job = String(body.jobId || '')
  if (!ID.test(job)) throw new EngineError(400, 'Say which job the marks are for')
  const { jobId, ...rest } = body
  return call(`/issues/${job}/reviews`, { ...options, method: 'POST', body: rest })
}

/** The kept record: every review sent, for one job or one project or the whole studio, newest first. */
export async function reviewRecord({ job, project, id } = {}, options) {
  if (id) {
    if (!ID.test(id)) throw new EngineError(400, 'That is not a review id')
    return call(`/reviews/${id}`, options)
  }
  if (job) return { reviews: await call(`/issues/${encodeURIComponent(job)}/reviews`, options) }
  const cid = await companyId(options)
  if (project && !ID.test(project)) throw new EngineError(400, 'That is not a project id')
  return { reviews: await call(`/companies/${cid}/reviews${project ? `?projectId=${project}` : ''}`, options) }
}
