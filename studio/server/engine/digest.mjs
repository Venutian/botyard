/**
 * The owner's decision digest (docs/digest.md): one short list instead of a stream of cards.
 *
 * Every card that waits for the owner has a kind (card-kind.mjs). A `default` card carries the answer the bot
 * would choose; when it has waited a day, the engine applies that answer by itself, writes down that it was
 * applied by default, and wakes the bot as the owner's own answer would. For seven days the owner can take it
 * back: the question is open again, waits for the owner alone, and the bot is told. A `must` card is never
 * answered by the engine.
 *
 * The digest is what the PC page and the phone show first: at most five cards, `must` first, each with its
 * default and when it applies. Cards that ask the same thing (one job asking again, or one request asking the
 * same question from several of its jobs) are one card with a count.
 */
import { ownerOnly } from './caller.mjs'
import { REVERSE_FOR_MS, askText, defaultOf, kindOf, ownerOf } from './card-kind.mjs'
import { rerunTrip } from './tracks.mjs'
import { Refused, addComment, note, wake } from './write.mjs'

/** The most cards a digest shows. */
export const DIGEST_CARDS = 5
const ENGINE = { user: 'engine:default' }
const iso = (now) => new Date(now).toISOString()
const flat = (value, most) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, most)
const positionOf = (store, id) => store.row('SELECT position FROM cards WHERE id = ?', id).position
const jobOf = (store, id) => store.object('SELECT raw FROM jobs WHERE id = ?', id)

/** The cards that still wait for the owner, each with its job. A cancelled job's card is moot. */
function waiting(store) {
  const out = []
  for (const card of store.objects("SELECT raw FROM cards WHERE status = 'pending' ORDER BY created_at")) {
    const job = jobOf(store, card.issueId)
    if (job && job.status !== 'cancelled') out.push({ card, job })
  }
  return out
}

/** A card with what the engine keeps about the owner's decision; one made before this existed starts its day now. */
function stamped(store, card, now) {
  if (card.owner?.kind) return card
  const next = { ...card, owner: ownerOf(card, now) }
  store.put('cards', next, { position: positionOf(store, card.id) })
  return next
}

/**
 * The engine's turn for defaults: every `default` card that has waited its day gets its default answer. The kind
 * is worked out again from the card as it is now, so a card that is (or has become) `must` is never applied.
 * Returns what it applied.
 */
export function applyDefaults(store, { now = Date.now() } = {}) {
  const applied = []
  for (const { card: found, job } of waiting(store)) {
    const card = stamped(store, found, now)
    if (card.owner.kind !== 'default' || !card.owner.applyAt || Date.parse(card.owner.applyAt) > now) continue
    const fresh = kindOf(card)
    if (fresh.kind !== 'default') {
      // Its words or its answers changed since it was stamped: it is the owner's now.
      store.put('cards', { ...card, owner: ownerOf(card, now) }, { position: positionOf(store, card.id) })
      continue
    }
    const choice = fresh.default
    const confirm = card.kind === 'request_confirmation'
    const status = confirm ? (choice.answer === 'accept' ? 'accepted' : 'rejected') : 'answered'
    const result = confirm
      ? { outcome: status, ...(choice.answer === 'reject' ? { reason: choice.reason || 'Applied by default: the owner did not answer within a day' } : {}), appliedByDefault: true, answer: choice.label }
      : { answers: choice.answers, appliedByDefault: true, answer: choice.label }
    const settled = {
      ...card, status, result, resolvedAt: iso(now), updatedAt: iso(now), resolvedByUserId: null, resolvedByAgentId: null, resolvedBy: 'default',
      owner: { ...card.owner, default: choice, appliedAt: iso(now), reverseUntil: iso(now + REVERSE_FOR_MS) },
    }
    store.put('cards', settled, { position: positionOf(store, card.id) })
    note(store, 'issue.interaction_applied_by_default', { type: 'issue', id: job.id }, ENGINE, { kind: card.kind, cardId: card.id, answer: choice.label }, now)
    // The bot that asked goes on as it would after the owner's own answer. A gate's trip reads the card itself.
    if (card.continuationPolicy !== 'none' && job.assigneeAgentId && !['done', 'cancelled'].includes(job.status)) {
      try { wake(store, job.assigneeAgentId, { issueId: job.id, source: 'automation', reason: 'card_answered', payload: { interactionId: card.id, appliedByDefault: true } }, { now, actor: ENGINE }) } catch { /* the bot was removed: the answer is kept all the same */ }
    }
    applied.push({ id: card.id, jobId: job.id, job: job.identifier, title: card.title || '', answer: choice.label })
  }
  return applied
}

/** Whether the engine can still take an applied default back, and why not when it cannot. */
function reversible(store, card, job, now) {
  if (!card.owner?.appliedAt || card.owner.reversedAt) return 'This answer was not applied by default'
  if (now > Date.parse(card.owner.reverseUntil || 0)) return 'The seven days to take this answer back are over'
  if (card.payload?.tripId) {
    const trip = store.object('SELECT raw FROM trips WHERE id = ?', card.payload.tripId)
    if (!trip) return 'Its request is gone'
    if (trip.status === 'done' || trip.status === 'not-in-main') return 'Its request has finished: the engine cannot undo that'
    return ''
  }
  if (!job || ['done', 'cancelled'].includes(job.status)) return 'Its job is finished: the engine cannot undo that'
  return ''
}

/**
 * The owner takes back an answer that was applied by default. The question is open again and is now the owner's
 * alone (it is never applied by default twice). On a job, the bot is told to stop acting on the default and wait;
 * at a gate, the trip goes back to the gate and asks again.
 */
export function reverseDefault(store, jobId, cardId, { now = Date.now(), actor } = {}) {
  ownerOnly(actor, 'takes back a default answer')
  const job = store.object('SELECT raw FROM jobs WHERE id = ? OR identifier = ?', jobId, jobId)
  const card = job && store.object('SELECT raw FROM cards WHERE id = ? AND job_id = ?', cardId, job.id)
  if (!card) throw new Refused(404, 'Interaction not found')
  const why = reversible(store, card, job, now)
  if (why) throw new Refused(409, why)
  const was = card.owner.default?.label || ''
  const owner = { ...card.owner, reversedAt: iso(now), reversedAnswer: was }
  if (card.payload?.tripId) {
    // The applied card stays as the record; the gate asks again on a card of its own, for the owner alone.
    store.put('cards', { ...card, owner, updatedAt: iso(now) }, { position: positionOf(store, card.id) })
    const trip = store.object('SELECT raw FROM trips WHERE id = ?', card.payload.tripId)
    store.put('trips', { ...trip, heldForOwner: card.payload.stepId, updatedAt: iso(now) })
    rerunTrip(store, trip.id, { step: card.payload.stepId, findings: card.payload.findings || '' }, { now, actor })
  } else {
    store.put('cards', {
      ...card, status: 'pending', result: null, resolvedAt: null, resolvedBy: null, updatedAt: iso(now), ownerKind: 'must', mustWhy: 'You took back its default answer',
      owner: { ...owner, kind: 'must', topic: 'said', why: 'You took back its default answer', applyAt: null, appliedAt: null, reverseUntil: null },
    }, { position: positionOf(store, card.id) })
    addComment(store, job.id, { body: `The owner took back the answer that was applied by default to "${flat(card.title, 200) || 'your card'}"${was ? ` (${was})` : ''}. Stop acting on it, undo what you can of it, and wait for the owner's own answer on that card.` }, { now, actor })
  }
  note(store, 'issue.interaction_default_reversed', { type: 'issue', id: job.id }, actor, { kind: card.kind, cardId: card.id, answer: was }, now)
  return store.object('SELECT raw FROM cards WHERE id = ?', card.id)
}

/** The job a card belongs under for folding: a gate's request, a step's or a child's parent, or the job itself. */
const rootOf = (card, job) => card.payload?.tripId ? `trip:${card.payload.tripId}` : `job:${job.parentId || job.id}`

/**
 * The digest: at most five cards, `must` first (the longest waiting first), then `default` (the soonest to apply
 * first); how many cards were folded into the ones shown; how many more wait behind the five; and the answers
 * applied by default that can still be taken back.
 */
export function digest(store, companyId, { now = Date.now() } = {}) {
  if (!store.row('SELECT id FROM company WHERE id = ?', companyId)) throw new Refused(404, 'Company not found')
  // Groups: every card of one job is one group; groups of one request that ask the same words are one group.
  const groups = new Map()
  const bySame = new Map()
  for (const { card, job } of waiting(store)) {
    const own = card.owner?.kind ? card.owner : ownerOf(card, now)
    const same = `${rootOf(card, job)}|${askText(card)}`
    const key = groups.has(job.id) ? job.id : bySame.get(same) || job.id
    if (!bySame.has(same)) bySame.set(same, key)
    const group = groups.get(key) || groups.set(key, []).get(key)
    group.push({ card, job, own })
  }
  const names = new Map(store.rows('SELECT id, name FROM agents').map((a) => [a.id, a.name]))
  const cards = [...groups.values()].map((group) => {
    // What is shown for the group: a `must` card before a `default` one, then the newest.
    const shown = [...group].sort((a, b) => (a.own.kind === 'must' ? 0 : 1) - (b.own.kind === 'must' ? 0 : 1) || String(b.card.createdAt).localeCompare(String(a.card.createdAt)))[0]
    const { card, job, own } = shown
    const since = group.map((g) => String(g.card.createdAt)).sort()[0]
    const count = group.reduce((sum, g) => sum + (g.card.asked || 1), 0)
    const botId = job.conversationAgentId || card.createdByAgentId || job.assigneeAgentId || ''
    return {
      id: card.id, jobId: job.id, job: job.conversationAgentId ? '' : job.identifier || '', chat: Boolean(job.conversationAgentId), botId, bot: names.get(botId) || '',
      title: flat(card.title, 200) || 'A bot asks you', question: flat(card.payload?.questions?.[0]?.prompt || card.payload?.prompt || card.summary, 240),
      kind: own.kind, why: own.kind === 'must' ? own.why : '', default: own.kind === 'default' ? own.default?.label || '' : '', appliesAt: own.kind === 'default' ? own.applyAt : null,
      answers: card.kind === 'request_confirmation' ? 'confirm' : 'choice', count, since, ...(card.payload?.tripId ? { tripId: card.payload.tripId } : {}),
    }
  }).sort((a, b) => (a.kind === 'must' ? 0 : 1) - (b.kind === 'must' ? 0 : 1) || (a.kind === 'must' ? a.since.localeCompare(b.since) : String(a.appliesAt).localeCompare(String(b.appliesAt))))
  const applied = store.objects("SELECT raw FROM cards WHERE status != 'pending' AND resolved_at >= ? ORDER BY resolved_at DESC", iso(now - REVERSE_FOR_MS))
    .filter((c) => c.owner?.appliedAt && !c.owner.reversedAt)
    .map((c) => {
      const job = jobOf(store, c.issueId)
      const why = reversible(store, c, job, now)
      return { id: c.id, jobId: c.issueId, job: job?.conversationAgentId ? '' : job?.identifier || '', title: flat(c.title, 200) || 'A card', answer: c.owner.default?.label || '', appliedAt: c.owner.appliedAt, reverseUntil: c.owner.reverseUntil, canReverse: !why, ...(why ? { whyNot: why } : {}) }
    })
  return {
    cards: cards.slice(0, DIGEST_CARDS), waiting: cards.length, more: Math.max(0, cards.length - DIGEST_CARDS),
    must: cards.filter((c) => c.kind === 'must').length, folded: cards.reduce((sum, c) => sum + c.count - 1, 0),
    applied: applied.slice(0, DIGEST_CARDS), appliedCount: applied.length, at: iso(now),
  }
}

const one = '([^/]+)'
/** The path that changes a card here: (store, parts, body, ctx) → [status, answer]. */
export const DIGEST_WRITES = [
  ['POST', new RegExp(`^/issues/${one}/interactions/${one}/reverse$`), (s, p, b, c) => [200, reverseDefault(s, p[0], p[1], c)]],
]

/** The answer for the digest's path, or null when it is another path. */
export function readDigest(store, where, { now = Date.now() } = {}) {
  const match = new RegExp(`^/companies/${one}/digest$`).exec(where)
  return match ? { status: 200, body: digest(store, decodeURIComponent(match[1]), { now }) } : null
}

export { defaultOf, kindOf }
