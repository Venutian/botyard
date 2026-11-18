/**
 * The answer tray: answers the owner has written but not sent yet, kept beside "Needs you".
 *
 * A bot's question waits in Needs you while the crew carries on with other work. The owner can answer
 * several there, one after another, and each answer is held here instead of going at once; one press
 * then sends them all, each to the job that asked. A review whose marks are ready can be held the same
 * way. Nothing here changes the Needs you count: a held answer is still a question waiting until it is
 * sent. The tray is kept in a small file beside the cards file, so the map and the phone hold the same
 * answers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { guardFolder } from './guard.mjs'
import { EngineError, acceptQuestion, answerQuestion, call, companyId, questionView, rejectQuestion } from './engine.mjs'
import { sendMarks } from './marks.mjs'

export const trayFile = (env = process.env) => path.join(guardFolder(env), 'tray.json')
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS = new Set(['answer', 'accept', 'reject', 'review'])
const MOST = 60
const MAX_TEXT = 8000

export function readTray(file = trayFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}

function writeTray(items, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ items }, null, 1))
  fs.renameSync(temp, file)
}

/** One held item made safe: what it answers, and the answer. */
export function cleanItem(raw = {}) {
  const kind = String(raw.kind || '')
  if (!KINDS.has(kind)) throw new EngineError(400, 'Hold an answer, a yes, a no or a review')
  const jobId = String(raw.jobId || '')
  if (!ID.test(jobId)) throw new EngineError(400, 'Say which job the answer is for')
  const title = String(raw.title || '').slice(0, 300)
  const job = String(raw.job || '').slice(0, 300)
  if (kind === 'review') {
    const review = raw.review && typeof raw.review === 'object' ? raw.review : null
    if (!review || !Array.isArray(review.marks)) throw new EngineError(400, 'A held review needs its marks')
    if (JSON.stringify(review).length > 200_000) throw new EngineError(413, 'That review is too long to hold')
    return { key: `review:${jobId}`, kind, jobId, title: title || 'Your review', job, review: { ...review, jobId } }
  }
  const cardId = String(raw.cardId || '')
  if (!ID.test(cardId)) throw new EngineError(400, 'Say which question the answer is for')
  const out = { key: `card:${jobId}:${cardId}`, kind, jobId, cardId, title, job, ...(ID.test(String(raw.botId || '')) ? { botId: String(raw.botId) } : {}) }
  if (kind === 'answer') {
    if (!Array.isArray(raw.answers) || !raw.answers.length || raw.answers.length > 20) throw new EngineError(400, 'Answer the question first')
    out.answers = raw.answers.map((a) => ({
      questionId: String(a?.questionId || '').slice(0, 200),
      optionIds: Array.isArray(a?.optionIds) ? a.optionIds.map(String).slice(0, 30) : [],
      ...(a?.otherText ? { otherText: String(a.otherText).slice(0, MAX_TEXT) } : {}),
    }))
    out.said = String(raw.said || '').slice(0, 500)
  }
  if (kind === 'reject' && raw.reason) out.reason = String(raw.reason).slice(0, MAX_TEXT)
  return out
}

/** Put an answer in the tray. A second answer to the same question takes the first one's place. */
export function holdItem(raw, { file = trayFile(), now = Date.now() } = {}) {
  const item = { ...cleanItem(raw), heldAt: now }
  const items = readTray(file).filter((i) => i.key !== item.key)
  if (items.length >= MOST) throw new EngineError(409, `The tray holds ${MOST} answers: send them first`)
  writeTray([...items, item], file)
  return { items: [...items, item] }
}

export function dropItem(key, { file = trayFile() } = {}) {
  const items = readTray(file).filter((i) => i.key !== key)
  writeTray(items, file)
  return { items }
}

/** How one held item is sent: to its own job, the way the card or the review would be answered there. */
async function sendOne(item, { settle, ...options }) {
  if (item.kind === 'review') return sendMarks(item.review, options)
  if (item.kind === 'answer') return answerQuestion(item.jobId, item.cardId, item.answers, options)
  if (item.kind === 'accept') { const out = await acceptQuestion(item.jobId, item.cardId, options); await settle?.(item.cardId, 'accept', {}); return out }
  const out = await rejectQuestion(item.jobId, item.cardId, item.reason, options)
  await settle?.(item.cardId, 'reject', { reason: item.reason || '' })
  return out
}

/**
 * Send every held item (or the ones named), each to the job that asked. One that fails stays in the
 * tray with why; the others go.
 */
export async function sendTray({ keys = null, file = trayFile(), settle = null, ...options } = {}) {
  const items = readTray(file)
  const chosen = items.filter((i) => !keys || keys.includes(i.key))
  const results = []
  for (const item of chosen) {
    try {
      await sendOne(item, { settle, ...options })
      results.push({ key: item.key, ok: true })
    } catch (err) {
      results.push({ key: item.key, ok: false, error: err.message || 'It did not go' })
    }
  }
  const sent = new Set(results.filter((r) => r.ok).map((r) => r.key))
  const failed = new Map(results.filter((r) => !r.ok).map((r) => [r.key, r.error]))
  const left = readTray(file).filter((i) => !sent.has(i.key)).map((i) => (failed.has(i.key) ? { ...i, error: failed.get(i.key) } : i))
  writeTray(left, file)
  return { sent: sent.size, failed: failed.size, results, items: left }
}

/** The questions a job (or a bot's chat) has waiting, drawn the way a card is drawn, to answer from the tray. */
export async function waitingQuestions({ job, bot } = {}, options) {
  let jobId = job
  if (bot) {
    if (!ID.test(bot)) throw new EngineError(400, 'That is not a bot id')
    const cid = await companyId(options)
    jobId = (await call(`/companies/${cid}/chats/${bot}`, { ...options, method: 'POST', body: {} })).id
  }
  if (!ID.test(String(jobId || ''))) throw new EngineError(400, 'Say which job')
  const [issue, cards] = await Promise.all([call(`/issues/${jobId}`, options), call(`/issues/${jobId}/interactions`, options)])
  return {
    jobId,
    job: `${issue.displayIdentifier || issue.identifier || ''} ${issue.title || ''}`.trim(),
    questions: cards.filter((c) => c.status === 'pending').map((c) => ({ at: c.createdAt, ...questionView(c) })).filter((q) => q.kind),
  }
}
