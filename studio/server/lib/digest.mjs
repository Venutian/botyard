/**
 * The owner's decision digest as the page and the phone show it (docs/digest.md): at most five cards, the ones
 * only the owner may answer first, each default card with its answer and when that answer applies by itself,
 * and the answers already applied by default that can still be taken back. The engine decides all of it; this
 * only adds the short words a screen prints.
 */
import { EngineError, call, companyId } from './engine.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How long until a time, in a few letters: "now", "in 20 min", "in 5 h", "in 3 d". */
export function untilWords(at, now = Date.now()) {
  const ms = Date.parse(at || '') - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 60_000) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} h`
  return `in ${Math.round(minutes / 1440)} d`
}

/** One line under a card: why it is the owner's, or its default and when that applies. */
export function cardLine(card, now = Date.now()) {
  if (card.kind === 'must') return card.why || 'Waits for your own answer'
  return `Default: ${card.default}. Applies ${untilWords(card.appliesAt, now)}.`
}

/** The engine's digest with the words a screen prints. */
export function shapeDigest(raw = {}, now = Date.now()) {
  const cards = (raw.cards || []).map((c) => ({ ...c, line: cardLine(c, now) }))
  const applied = (raw.applied || []).map((a) => ({ ...a, line: a.canReverse ? `Applied by default: ${a.answer}. Take back ${untilWords(a.reverseUntil, now).replace(/^in /, 'within ')}.` : `Applied by default: ${a.answer}. ${a.whyNot || 'It can no longer be taken back'}.` }))
  const folded = Number(raw.folded) || 0
  const more = Number(raw.more) || 0
  const notes = [folded ? `${folded} repeat${folded === 1 ? '' : 's'} folded in` : '', more ? `${more} more below` : ''].filter(Boolean).join(', ')
  return { cards, applied, waiting: Number(raw.waiting) || 0, must: Number(raw.must) || 0, folded, more, notes, at: raw.at || new Date(now).toISOString() }
}

export async function digestView(options) {
  const id = await companyId(options)
  return shapeDigest(await call(`/companies/${id}/digest`, options))
}

/** The owner takes back an answer that was applied by default; the digest as it is after. */
export async function takeBackDefault({ jobId, cardId } = {}, options) {
  if (!ID.test(String(jobId || '')) || !ID.test(String(cardId || ''))) throw new EngineError(400, 'Say which card to take back')
  await call(`/issues/${jobId}/interactions/${cardId}/reverse`, { ...options, method: 'POST', body: {} })
  return digestView(options)
}
