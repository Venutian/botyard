/**
 * What kind of decision an owner card is (docs/digest.md), worked out from the card alone.
 *
 *   must     only the owner may answer: money, deleting work that is not merged, a store release, final art,
 *            a sign-in; a card whose answer the engine could not take back; a card with no default answer
 *   default  everything else. It carries the answer the bot would choose, and the engine applies that answer
 *            by itself when the card has waited a day (digest.mjs)
 *
 * Nothing here reads the store, so the code that writes cards and the code that reads them share it.
 */

export const DAY_MS = 24 * 3600 * 1000
/** How long a default card waits for the owner before its default is applied. */
export const DEFAULT_AFTER_MS = DAY_MS
/** How long an answer applied by default can be taken back. */
export const REVERSE_FOR_MS = 7 * DAY_MS

// Spending, not selling: "which colour for the buy button" and "how does a buyer pay" are design; "buy the font
// licence" and "do we pay for it" are a spend. An amount of money is always the owner's.
const MONEY = /\b(spend|spending|(?:pay|paying) for|(?:we|you|i) (?:pay|buy)|(?:buy|buying|purchase|purchasing) (?:a|an|the|this|that|it|more|another|\d)|paid plan|subscribe to|subscription|invoice|budget|billing|refund|credit card)\b|[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:eur|usd|gbp|sek|dollars?|euros?)\b/
const DELETE = /\b(delete|deleting|remove|removing|discard|discarding|throw away|wipe|force[- ]push)\b[^.?!\n]*\b(branch|branches|worktrees?|commits?|unmerged|not merged|work)\b|\b(unmerged|not (?:yet )?merged)\b[^.?!\n]*\b(delete|remove|discard|drop)\b/
const RELEASE = /\b(app store|play store|google play|testflight|steam|itch\.io|the stores?)\b[^.?!\n]*\b(release|submit|submission|publish|go live|sent? for review)\b|\b(release|submit|publish|send)\b[^.?!\n]*\b(app store|play store|google play|testflight|steam|itch\.io|the stores?|store review)\b/
const ART = /\bfinal (art|artwork|logo|icon|cover|capsule|key art|illustration)\b/
const SIGN_IN = /\b(sign[- ]?in|sign[- ]?up|log[- ]?in|password|passkey|2fa|two[- ]factor|api key|access token|credentials|oauth|verification code)\b/

/** The five things only the owner decides, each with the words a card shows for it. */
export const MUST_TOPICS = [
  ['money', MONEY, 'It spends money'],
  ['delete', DELETE, 'It deletes work that is not merged'],
  ['release', RELEASE, 'It is a store release'],
  ['art', ART, 'It is final art'],
  ['sign-in', SIGN_IN, 'It needs your sign-in'],
]

const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Everything a card asks, as one line of text: its title, its question and what can be chosen. */
export function cardText(card = {}) {
  const payload = card.payload || {}
  const parts = [card.title, payload.prompt || card.summary]
  for (const q of Array.isArray(payload.questions) ? payload.questions : []) {
    parts.push(q?.prompt)
    for (const o of Array.isArray(q?.options) ? q.options : []) parts.push(o?.label, o?.description)
  }
  return flat(parts.filter(Boolean).join(' . '))
}

/**
 * The question a card asks, in the form two cards are compared by: the same words asked again are the same
 * question, whatever the round, the count in the title or the spacing.
 */
export function askText(card = {}) {
  const payload = card.payload || {}
  const asked = Array.isArray(payload.questions) && payload.questions.length ? payload.questions.map((q) => `${q?.prompt}${String(q?.selectionMode ?? q?.answerMode ?? '').toLowerCase().startsWith('multi') ? ' [pick several]' : ''}`).join(' | ') : payload.prompt || card.summary || card.title
  return flat(asked).toLowerCase().replace(/\s*\((?:asked \d+ times|round \d+)\)/g, '').slice(0, 2000)
}

const RECOMMENDED = /\(recommended\)|\brecommended\b/i

/**
 * The answer the bot would choose, or null when the card names none. A yes-or-no card says it as
 * `payload.default` ("accept" or "reject", with `defaultReason` for a no). A question card says it per question:
 * `default` (an option's id) on the question, `recommended: true` on an option, or "(recommended)" in its label.
 * Every question that must be answered needs one, or the card has no default.
 */
export function defaultOf(card = {}) {
  const payload = card.payload || {}
  if (card.kind === 'request_confirmation') {
    const said = flat(typeof payload.default === 'object' ? payload.default?.answer : payload.default).toLowerCase()
    const answer = ['accept', 'yes'].includes(said) ? 'accept' : ['reject', 'no'].includes(said) ? 'reject' : ''
    if (!answer) return null
    return { answer, label: flat(answer === 'accept' ? payload.acceptLabel || 'Yes' : payload.rejectLabel || 'No').slice(0, 200), ...(answer === 'reject' && payload.defaultReason ? { reason: flat(payload.defaultReason).slice(0, 2000) } : {}) }
  }
  if (card.kind !== 'ask_user_questions' || !Array.isArray(payload.questions) || !payload.questions.length) return null
  const answers = []
  const labels = []
  for (const q of payload.questions) {
    const options = (Array.isArray(q?.options) ? q.options : []).filter((o) => o && !o.freeText)
    const named = q?.default ?? q?.defaultOptionId ?? payload.defaults?.[q?.id]
    const pick = options.find((o) => named !== undefined && named !== null && String(o.id) === String(named)) || options.find((o) => o.recommended === true) || options.find((o) => RECOMMENDED.test(String(o.label || '')))
    if (!pick) {
      if (q?.required === false) continue
      return null
    }
    answers.push({ questionId: q.id, optionIds: [pick.id] })
    labels.push(flat(pick.label))
  }
  return answers.length ? { answers, label: labels.join(', ').slice(0, 200) } : null
}

/**
 * A card's kind and why. `must` wins every doubt: the card (or the engine, for a gate) says so, its words name one
 * of the five things, or there is no default to apply.
 */
export function kindOf(card = {}) {
  const payload = card.payload || {}
  if (card.ownerKind === 'must' || payload.ownerKind === 'must') return { kind: 'must', topic: 'said', why: flat(payload.mustWhy || card.mustWhy).slice(0, 200) || 'It waits for your own answer' }
  const text = cardText(card).toLowerCase()
  for (const [topic, pattern, why] of MUST_TOPICS) if (pattern.test(text)) return { kind: 'must', topic, why }
  const choice = defaultOf(card)
  if (!choice) return { kind: 'must', topic: 'no-default', why: 'It names no default answer' }
  return { kind: 'default', topic: '', why: '', default: choice }
}

/**
 * What the engine keeps on a card about the owner's decision: its kind, why, the default and when it applies.
 * The clock starts at `now`: when the card is made, when its question changes, or when a card made before this
 * existed is first seen.
 */
export function ownerOf(card, now) {
  const found = kindOf(card)
  if (found.kind === 'must') return { kind: 'must', topic: found.topic, why: found.why, default: null, applyAt: null, since: new Date(now).toISOString() }
  return { kind: 'default', topic: '', why: '', default: found.default, applyAt: new Date(now + DEFAULT_AFTER_MS).toISOString(), since: new Date(now).toISOString() }
}
