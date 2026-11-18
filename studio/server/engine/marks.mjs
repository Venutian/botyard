/**
 * Reviews: the owner marks exact places in what a bot made, and every mark goes back as one message.
 *
 * A review is about one **piece**: a bot's message, the job's brief, one of its documents (a plan, a
 * report), a picture, a change's files, or a page of a running local build. Each **mark** pins a
 * comment to a place in it:
 *
 *   text     words or lines: the quote, and where it is (document and line, message and paragraph, file and line)
 *   picture  a point or a box on a picture: the box as fractions of the picture; a cut copy goes with it
 *   page     an element of a local page: its address, the element and a screenshot (cut like a picture)
 *
 * Sending a review is the owner's alone (a bot's pass is refused, as for answering a card or a gate).
 * It becomes one comment on the job, which wakes the job's bot like any word from the owner, with the
 * cut copies of pictures carried beside the words. When the job is a trip waiting at a gate
 * (docs/tracks.md), the review is the gate's answer instead: the rendered marks are the note the work
 * goes back with, and nothing else is posted. Every review sent is kept, read-only, as the record of
 * what the owner approved or sent back and why.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ownerOnly } from './caller.mjs'
import { cropMark } from './crop.mjs'
import { displayOf } from './codes.mjs'
import { attach, fileOf } from './files.mjs'
import { answerGate, tripView } from './tracks.mjs'
import { MOST_FILES_PER_COMMENT, Refused, addComment } from './write.mjs'
import fs from 'node:fs'

export const MARK_KINDS = ['text', 'picture', 'page']
export const PIECE_KINDS = ['message', 'brief', 'document', 'picture', 'change', 'page', 'file', 'work']
export const VERDICTS = ['back', 'context', 'approve', 'note']
export const MOST_MARKS = 40
const COMMENT_CHARS = 2000
const QUOTE_CHARS = 1500
const NOTE_CHARS = 4000
/** A gate's note is kept to this length (the track's own limit is larger); the whole review stays readable by its id. */
const GATE_NOTE_CHARS = 12000

const iso = (now) => new Date(now).toISOString()
const words = (value, most) => String(value ?? '').replace(/\r\n?/g, '\n').slice(0, most)
const squash = (value) => String(value || '').replace(/\s+/g, ' ').trim()
const localAddress = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?(\/|$)/i

function jobOr404(store, ref) {
  const job = store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', ref, String(ref).toUpperCase())
  if (!job) throw new Refused(404, 'Job not found')
  return job
}

const agentName = (store, id) => (id ? store.object('SELECT raw FROM agents WHERE id = ?', id)?.name || 'a bot' : 'you')

/** The text a piece is made of, where the engine holds it: the brief, a document, a message. */
export function pieceText(store, job, piece) {
  if (piece.kind === 'brief') return { text: job.description || '', label: 'the job\'s brief' }
  if (piece.kind === 'document') {
    const key = String(piece.ref || '').trim().toLowerCase()
    const link = store.row('SELECT document_id FROM job_documents WHERE job_id = ? AND key = ?', job.id, key)
    const doc = link && store.object('SELECT raw FROM documents WHERE id = ?', link.document_id)
    if (!doc) throw new Refused(404, `This job has no document "${key}"`)
    return { text: doc.body || '', label: `document "${key}"` }
  }
  if (piece.kind === 'message') {
    const comment = store.object('SELECT raw FROM comments WHERE id = ? AND job_id = ?', String(piece.ref || ''), job.id)
    if (!comment) throw new Refused(404, 'That message is not on this job')
    const at = new Date(comment.createdAt)
    const when = `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`
    return { text: comment.body || '', label: `${agentName(store, comment.authorAgentId)}'s message of ${when}` }
  }
  return null
}

/** Line numbers (from 1) and paragraph numbers of the passage; null when the words are not there. */
export function placeOf(text, quote, hint = 0) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const want = squash(quote)
  if (!want) return null
  // Each line's start in the squashed text, so a quote that runs over several lines is found too.
  let flat = ''
  const starts = []
  for (const line of lines) {
    const s = squash(line)
    starts.push(flat.length)
    flat += (flat && s ? ' ' : '') + s
  }
  const lineAt = (offset) => {
    let n = 0
    while (n + 1 < starts.length && starts[n + 1] <= offset) n++
    return n
  }
  const found = []
  for (let i = flat.indexOf(want); i >= 0; i = flat.indexOf(want, i + 1)) found.push(i)
  if (!found.length) return null
  // Where the quote is more than once, the one nearest the line the owner marked.
  const best = found.reduce((a, b) => (Math.abs(lineAt(b) + 1 - hint) < Math.abs(lineAt(a) + 1 - hint) ? b : a))
  const first = lineAt(best)
  const last = lineAt(best + want.length - 1)
  let paragraph = 0
  for (let i = 0; i <= first; i++) if (lines[i].trim() && (i === 0 || !lines[i - 1].trim())) paragraph++
  paragraph = Math.max(1, paragraph)
  return { line: first + 1, lineEnd: last + 1, paragraph, count: found.length }
}

function cleanMark(raw, n) {
  if (!raw || typeof raw !== 'object') throw new Refused(400, `Mark ${n} is not a mark`)
  const kind = String(raw.kind || '')
  if (!MARK_KINDS.includes(kind)) throw new Refused(400, `Mark ${n}: a mark is on text, a picture or a page`)
  const comment = words(raw.comment, COMMENT_CHARS).trim()
  if (!comment) throw new Refused(400, `Mark ${n} has no comment: say what to change there`)
  const out = { n, kind, comment }
  // A mark may name its own piece, so one review can hold marks on the plan and on a picture alike.
  if (raw.piece && typeof raw.piece === 'object' && PIECE_KINDS.includes(raw.piece.kind)) out.piece = { kind: raw.piece.kind, ref: String(raw.piece.ref || '').slice(0, 300) }
  if (kind === 'text') {
    out.quote = words(raw.quote, QUOTE_CHARS).trim()
    if (!out.quote) throw new Refused(400, `Mark ${n} marks no words`)
    if (raw.file) out.file = words(raw.file, 300).trim()
    if (Number.isFinite(Number(raw.line)) && Number(raw.line) > 0) out.line = Math.trunc(Number(raw.line))
    if (Number.isFinite(Number(raw.lineEnd)) && Number(raw.lineEnd) >= (out.line || 0)) out.lineEnd = Math.trunc(Number(raw.lineEnd))
    if (raw.chapter) out.chapter = words(raw.chapter, 200).trim()
  }
  if (kind === 'picture' || kind === 'page') {
    const box = raw.box && typeof raw.box === 'object' ? raw.box : null
    if (kind === 'picture' && !box) throw new Refused(400, `Mark ${n}: tap a point or draw a box on the picture`)
    if (box) out.box = { x: Number(box.x) || 0, y: Number(box.y) || 0, w: Number(box.w) || 0, h: Number(box.h) || 0 }
    if (kind === 'picture') out.attachmentId = String(raw.attachmentId || '')
  }
  if (kind === 'page') {
    out.url = String(raw.url || '').slice(0, 2000)
    if (!localAddress.test(out.url)) throw new Refused(400, `Mark ${n}: only pages on this computer (localhost) can be marked`)
    out.element = words(raw.element, 400).trim()
    out.text = words(raw.text, 400).trim()
    if (raw.shotId) out.attachmentId = String(raw.shotId)
  }
  return out
}

/** Read a picture the owner marked: it must be a file of this studio. */
function pictureOf(store, companyId, id, ctx) {
  const file = store.object('SELECT raw FROM attachments WHERE id = ?', id)
  if (!file || file.companyId !== companyId) throw new Refused(404, 'That picture is not one of this studio\'s files')
  if (!String(file.contentType || '').startsWith('image/')) throw new Refused(400, `"${file.originalFilename}" is not a picture`)
  const where = fileOf(store, id, ctx)
  return { file, bytes: fs.readFileSync(where.path) }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const lineWords = (m) => (m.line ? (m.lineEnd && m.lineEnd !== m.line ? `lines ${m.line}–${m.lineEnd}` : `line ${m.line}`) : '')

/** Where one mark is, in words the bot can act on. */
export function whereOf(mark, piece) {
  if (mark.kind === 'text') {
    if (mark.file) return [`file ${mark.file}`, lineWords(mark), mark.chapter ? `(chapter "${mark.chapter}")` : ''].filter(Boolean).join(', ').replace(', (', ' (')
    if ((mark.piece || piece).kind === 'message') return [mark.label, mark.paragraph ? `paragraph ${mark.paragraph}` : '', lineWords(mark)].filter(Boolean).join(', ')
    return [mark.label, lineWords(mark)].filter(Boolean).join(', ')
  }
  if (mark.kind === 'picture') {
    const p = mark.pixels
    const size = mark.size ? ` of ${mark.size.width}×${mark.size.height}` : ''
    const spot = !p ? 'the marked place' : p.w || p.h ? `box x ${p.x}–${p.x + p.w}, y ${p.y}–${p.y + p.h}${size}` : `point x ${p.x}, y ${p.y}${size}`
    return `picture "${mark.picture}", ${spot}`
  }
  return [`page ${mark.url}`, mark.element ? `element ${mark.element}` : ''].filter(Boolean).join(', ')
}

/** The one message the bot receives. */
export function renderReview({ piece, marks, note, verdict, owner = 'the owner' }) {
  const head = verdict === 'approve'
    ? `Approved by ${owner}, with ${plural(marks.length, 'note')} on ${piece.title}.`
    : `Review of ${piece.title} from ${owner}: ${plural(marks.length, 'mark')}. Change each marked place, and answer each mark by its number in your reply.`
  const body = marks.map((m) => {
    const lines = [`${m.n}. ${whereOf(m, piece)}`]
    if (m.kind === 'text') lines.push(...m.quote.split('\n').slice(0, 12).map((l) => `   > ${l}`))
    if (m.kind === 'page' && m.text) lines.push(`   > ${m.text}`)
    if (m.cut) lines.push(`   Cut copy: ${m.cut.name} (${m.cut.path})`)
    else if (m.cutWhy) lines.push(`   (No cut copy: ${m.cutWhy}.)`)
    lines.push(`   Comment: ${m.comment.replace(/\n/g, '\n   ')}`)
    return lines.join('\n')
  })
  return [head, '', ...body.flatMap((b) => [b, '']), ...(note ? [`Overall: ${note}`] : [])].join('\n').trim()
}

/** The trip waiting at a gate on this job, if there is one: the owner's review answers it. */
export function gateOf(store, jobId) {
  // The request's own job, or the job a step of a trip made (where the work to look at is).
  const trips = [
    ...store.rows("SELECT t.id FROM trips t JOIN requests r ON r.id = t.request_id WHERE r.job_id = ? AND t.status = 'running' ORDER BY t.created_at DESC", jobId),
    ...store.rows("SELECT DISTINCT t.id FROM trips t JOIN trip_steps s ON s.trip_id = t.id WHERE s.job_id = ? AND t.status = 'running'", jobId),
  ]
  for (const { id: tripId } of trips) {
    const trip = tripView(store, tripId)
    const step = trip.steps.find((s) => s.id === trip.current)
    if (step?.kind === 'gate' && step.state === 'working') {
      const before = trip.steps.slice(0, trip.steps.indexOf(step)).map((s) => ({ id: s.id, title: s.title || s.id, kind: s.kind }))
      return { tripId, stepId: step.id, title: step.title || step.id, before }
    }
  }
  return null
}

/**
 * Send a review: the owner's marks on one piece, as one message to the job's bot, or as the answer
 * to the gate the job's trip waits at.
 */
export function sendReview(store, jobRef, body = {}, ctx = {}) {
  const { now = Date.now(), actor } = ctx
  ownerOnly(actor, 'sends marks')
  const job = jobOr404(store, jobRef)
  const kind = String(body.piece?.kind || '')
  if (!PIECE_KINDS.includes(kind)) throw new Refused(400, `Say what was reviewed: ${PIECE_KINDS.join(', ')}`)
  const verdict = VERDICTS.includes(body.verdict) ? body.verdict : 'back'
  const list = Array.isArray(body.marks) ? body.marks : []
  if (list.length > MOST_MARKS) throw new Refused(400, `A review carries at most ${MOST_MARKS} marks`)
  const note = words(body.note, NOTE_CHARS).trim()
  if (!list.length && !note && verdict !== 'approve') throw new Refused(400, 'Mark a place, or write what to change')
  const marks = list.map((m, i) => cleanMark(m, i + 1))
  const source = pieceText(store, job, { kind, ref: body.piece?.ref })
  const piece = { kind, ref: String(body.piece?.ref || '').slice(0, 300), title: words(body.piece?.title, 200).trim() || source?.label || kind }

  // Text marks on a piece the engine holds: where they are is read from the piece itself, not taken on trust.
  for (const m of marks) {
    if (m.kind !== 'text' || m.file) continue
    const own = m.piece ? pieceText(store, job, m.piece) : source
    if (!own) continue
    m.label = own.label
    const place = placeOf(own.text, m.quote, m.line || 0)
    if (place) Object.assign(m, { line: place.line, lineEnd: place.lineEnd, paragraph: place.paragraph })
    else throw new Refused(400, `Mark ${m.n}: those words are not in ${own.label} (it may have changed; open it again)`)
  }

  // Pictures and page shots: the place cut out and put on the job, so it goes with the words.
  const cuts = []
  for (const m of marks) {
    if (!m.attachmentId) continue
    const { file, bytes } = pictureOf(store, job.companyId, m.attachmentId, ctx)
    m.picture = file.originalFilename || 'picture'
    if (!m.box) continue
    const cut = cropMark(bytes, m.box)
    m.size = cut.size
    m.pixels = cut.marked
    if (!cut.png) { m.cutWhy = cut.why; continue }
    const base = path.basename(m.picture).replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'picture'
    const made = attach(store, job.companyId, job.id, { name: `mark-${m.n}-${base}.png`, type: 'image/png', bytes: cut.png }, ctx)
    m.cut = { id: made.id, name: made.originalFilename, path: made.contentPath }
    cuts.push(made.id)
  }

  const text = renderReview({ piece, marks, note, verdict })
  const id = randomUUID()
  const gate = body.gate ? gateOf(store, job.id) : null
  if (body.gate && (!gate || (body.gate.tripId && body.gate.tripId !== gate.tripId))) throw new Refused(409, 'This job is not waiting at a gate any more')
  let commentId = null
  if (gate) {
    const action = verdict === 'approve' ? 'approve' : verdict === 'context' ? 'context' : 'back'
    const to = action === 'back' ? String(body.gate.to || gate.before.at(-1)?.id || '') : body.gate.to || undefined
    const clipped = text.length > GATE_NOTE_CHARS ? `${text.slice(0, GATE_NOTE_CHARS)}\n…(the whole review: /api/reviews/${id})` : text
    answerGate(store, gate.tripId, { action, to, note: clipped, reviewId: id }, ctx)
  } else {
    // An approval with no gate is kept and said quietly: it asks the bot for nothing more.
    const quiet = verdict === 'approve' || verdict === 'note'
    const comment = addComment(store, job.id, { body: text, attachmentIds: cuts.slice(0, MOST_FILES_PER_COMMENT) }, { ...ctx, quiet })
    commentId = comment.id
  }
  const review = {
    id, companyId: job.companyId, jobId: job.id, jobRef: job.identifier ? displayOf(store, job.identifier) || job.identifier : null, projectId: job.projectId || null, botId: job.assigneeAgentId || null,
    piece, verdict, note, marks, text, commentId, gate: gate ? { tripId: gate.tripId, stepId: gate.stepId, to: body.gate?.to || null } : null,
    cuts, createdAt: iso(now), by: 'owner',
  }
  store.put('reviews', review)
  return review
}

// ── reading ───────────────────────────────────────────────────────────────────────

const LIMIT = 200

export const jobReviews = (store, ref) => store.objects('SELECT raw FROM reviews WHERE job_id = ? ORDER BY created_at DESC', jobOr404(store, ref).id)

export function companyReviews(store, companyId, query = {}) {
  const limit = Math.min(LIMIT, Math.max(1, Number(query.limit) || 50))
  if (query.projectId) return store.objects('SELECT raw FROM reviews WHERE company_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?', companyId, String(query.projectId), limit)
  return store.objects('SELECT raw FROM reviews WHERE company_id = ? ORDER BY created_at DESC LIMIT ?', companyId, limit)
}

export function getReview(store, id) {
  const found = store.object('SELECT raw FROM reviews WHERE id = ?', id)
  if (!found) throw new Refused(404, 'Review not found')
  return found
}

const one = '([^/]+)'
const READS = [
  [new RegExp(`^/issues/${one}/reviews$`), (s, p) => jobReviews(s, p[0])],
  [new RegExp(`^/issues/${one}/gate$`), (s, p) => ({ gate: gateOf(s, jobOr404(s, p[0]).id) })],
  [new RegExp(`^/companies/${one}/reviews$`), (s, p, q) => companyReviews(s, p[0], q)],
  [new RegExp(`^/reviews/${one}$`), (s, p) => getReview(s, p[0])],
]

export function readMarks(store, where, query = {}) {
  for (const [pattern, act] of READS) {
    const match = pattern.exec(where)
    if (match) return { status: 200, body: act(store, match.slice(1).map((part) => decodeURIComponent(part)), query) }
  }
  return null
}

export const MARK_WRITES = [
  ['POST', new RegExp(`^/issues/${one}/reviews$`), (s, p, b, c) => [201, sendReview(s, p[0], b, c)]],
]
