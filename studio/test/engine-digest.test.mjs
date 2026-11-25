/**
 * The owner's decision digest (docs/digest.md): each card is `must` or `default`; a default card's answer is
 * applied by itself after a day and can be taken back for seven; a must card is never applied; the same question
 * asked again is one card with a count; the digest shows five cards at most, must first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startEngine } from '../server/engine/main.mjs'
import { openStore } from '../server/engine/store.mjs'
import { DAY_MS, REVERSE_FOR_MS, askText, defaultOf, kindOf } from '../server/engine/card-kind.mjs'
import { DIGEST_CARDS, applyDefaults, digest, reverseDefault } from '../server/engine/digest.mjs'
import { saveTrack, startRequest, tickTracks, tripView } from '../server/engine/tracks.mjs'
import { createCard, createJob, putDocument, settleCard } from '../server/engine/write.mjs'

const OWNER = { user: 'local-board' }
const BOT = { agent: 'b1', run: 'r1' }
const T0 = Date.parse('2026-11-25T09:00:00Z')
const HOUR = 3600 * 1000

function yard() {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 0 })
  for (const [id, name] of [['b1', 'Builder'], ['j1', 'Judge']]) store.put('agents', { id, companyId: 'co', name, status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  const job = (title, more = {}) => createJob(store, 'co', { title, assigneeAgentId: 'b1', ...more }, { now: T0, actor: OWNER })
  return { store, job }
}

const choice = (prompt, options = ['Blue (recommended)', 'Red'], more = {}) => ({
  kind: 'ask_user_questions', title: prompt,
  payload: { questions: [{ id: 'q', prompt, options: options.map((label, n) => ({ id: `o${n + 1}`, label })) }] }, ...more,
})
const ask = (store, job, body, now = T0) => createCard(store, job.id, body, { now, actor: BOT })
const cardOf = (store, id) => store.object('SELECT raw FROM cards WHERE id = ?', id)

test('each card gets a kind: must for money, deleting unmerged work, a store release, final art and a sign-in; default for the rest', () => {
  const must = (title, topic) => assert.deepEqual([kindOf(choice(title)).kind, kindOf(choice(title)).topic], ['must', topic], title)
  must('Buy the font licence for 49 EUR?', 'money')
  must('Start the paid plan subscription?', 'money')
  // A question about what buyers pay with is design, not a spend.
  assert.equal(kindOf(choice('Which colour for the buy button on the checkout page?')).kind, 'default')
  assert.equal(kindOf(choice('Which payment form goes on the checkout page, so a buyer can pay on one page?')).kind, 'default')
  must('Delete the unmerged branch harbour-lamp?', 'delete')
  must('Discard the work on this branch and start over?', 'delete')
  must('Submit build 14 to the App Store for review?', 'release')
  must('Is this the final art for the cover?', 'art')
  must('I need you to sign in to the store account', 'sign-in')
  // Reversible work with a recommended answer is a default card, and carries that answer.
  const plain = kindOf(choice('Which colour for the lamp?'))
  assert.equal(plain.kind, 'default')
  assert.deepEqual(plain.default, { answers: [{ questionId: 'q', optionIds: ['o1'] }], label: 'Blue (recommended)' })
  // No answer named: nothing can be applied, so it is the owner's.
  assert.deepEqual([kindOf(choice('Which colour for the lamp?', ['Blue', 'Red'])).kind, kindOf(choice('Which colour?', ['Blue', 'Red'])).topic], ['must', 'no-default'])
  // A bot (or the engine, at a gate) may say must outright; nothing a card says makes a must topic a default.
  assert.equal(kindOf({ ...choice('Which colour?'), payload: { ...choice('Which colour?').payload, ownerKind: 'must', mustWhy: 'Cannot be undone' } }).why, 'Cannot be undone')
  assert.equal(kindOf({ kind: 'request_confirmation', title: 'Pay the invoice?', payload: { default: 'accept', ownerKind: 'default' } }).kind, 'must')
  // A yes-or-no card names its default as accept or reject.
  assert.deepEqual(defaultOf({ kind: 'request_confirmation', payload: { default: 'reject', rejectLabel: 'Keep the old page', defaultReason: 'Safer' } }), { answer: 'reject', label: 'Keep the old page', reason: 'Safer' })
  assert.equal(defaultOf({ kind: 'request_confirmation', payload: {} }), null)
  // A default named by an option's id, or by a flag on the option.
  assert.equal(defaultOf({ kind: 'ask_user_questions', payload: { questions: [{ id: 'q', prompt: 'P', default: 'b', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] } }).label, 'B')
  assert.equal(defaultOf({ kind: 'ask_user_questions', payload: { questions: [{ id: 'q', prompt: 'P', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', recommended: true }] }] } }).label, 'B')
})

test('a card is stamped with its kind when it is made: a default card with its answer and the time it applies', () => {
  const { store, job } = yard()
  const card = ask(store, job('Lamp colour'), choice('Which colour for the lamp?'))
  assert.equal(card.owner.kind, 'default')
  assert.equal(card.owner.default.label, 'Blue (recommended)')
  assert.equal(card.owner.applyAt, new Date(T0 + DAY_MS).toISOString())
  const spend = ask(store, job('Font'), choice('Buy the font licence for 49 EUR?'))
  assert.deepEqual([spend.owner.kind, spend.owner.why, spend.owner.applyAt], ['must', 'It spends money', null])
})

test('a default card is applied by itself once it has waited 24 hours, recorded as applied by default, and the bot is woken', () => {
  const { store, job } = yard()
  const j = job('Lamp colour')
  const card = ask(store, j, choice('Which colour for the lamp?'))
  store.db.exec("DELETE FROM wakes")
  assert.deepEqual(applyDefaults(store, { now: T0 + 23 * HOUR }), [], 'not before its day is over')
  assert.equal(cardOf(store, card.id).status, 'pending')
  const applied = applyDefaults(store, { now: T0 + DAY_MS })
  assert.deepEqual(applied.map((a) => [a.id, a.answer]), [[card.id, 'Blue (recommended)']])
  const after = cardOf(store, card.id)
  assert.equal(after.status, 'answered')
  assert.deepEqual(after.result, { answers: [{ questionId: 'q', optionIds: ['o1'] }], appliedByDefault: true, answer: 'Blue (recommended)' })
  assert.equal(after.resolvedBy, 'default')
  assert.equal(after.resolvedByUserId, null, 'it is not written down as the owner\'s answer')
  assert.equal(after.owner.appliedAt, new Date(T0 + DAY_MS).toISOString())
  assert.equal(after.owner.reverseUntil, new Date(T0 + DAY_MS + REVERSE_FOR_MS).toISOString())
  assert.equal(store.rows("SELECT id FROM activity WHERE action = 'issue.interaction_applied_by_default'").length, 1)
  assert.equal(store.rows("SELECT id FROM wakes WHERE agent_id = 'b1' AND status = 'queued'").length, 1)
  // It is applied once.
  assert.deepEqual(applyDefaults(store, { now: T0 + 2 * DAY_MS }), [])
  // A yes-or-no card's default is its yes or its no.
  const confirm = ask(store, job('Old page'), { kind: 'request_confirmation', title: 'Replace the old page?', payload: { prompt: 'Replace the old help page with the new one?', default: 'reject', rejectLabel: 'Keep the old page' } })
  applyDefaults(store, { now: T0 + DAY_MS })
  assert.deepEqual([cardOf(store, confirm.id).status, cardOf(store, confirm.id).result.appliedByDefault], ['rejected', true])
})

test('a must card never applies by itself, however long it waits; nor does a card the owner answered', () => {
  const { store, job } = yard()
  const spend = ask(store, job('Font'), choice('Buy the font licence for 49 EUR?'))
  const bare = ask(store, job('Tone'), choice('Which tone for the page?', ['Plain', 'Warm']))
  const said = ask(store, job('Art'), { ...choice('Which frame for the picture?'), ownerKind: 'must', mustWhy: 'The owner asked to see every frame' })
  const answered = ask(store, job('Lamp'), choice('Which colour for the lamp?'))
  settleCard(store, answered.issueId, answered.id, 'respond', { answers: [{ questionId: 'q', optionIds: ['o2'] }] }, { now: T0 + HOUR, actor: OWNER })
  for (const days of [1, 2, 30, 365]) assert.deepEqual(applyDefaults(store, { now: T0 + days * DAY_MS }), [])
  for (const card of [spend, bare, said]) assert.equal(cardOf(store, card.id).status, 'pending')
  assert.deepEqual(cardOf(store, answered.id).result, { answers: [{ questionId: 'q', optionIds: ['o2'] }] })
  // A card stamped default whose words now name money is the owner's: the kind is worked out again before applying.
  const turned = ask(store, job('Hosting'), choice('Which host for the page?'))
  store.put('cards', { ...cardOf(store, turned.id), title: 'Which host do we pay for?', payload: { questions: [{ id: 'q', prompt: 'Which paid plan do we buy?', options: [{ id: 'o1', label: 'Small (recommended)' }, { id: 'o2', label: 'Big' }] }] } }, { position: 0 })
  assert.deepEqual(applyDefaults(store, { now: T0 + 3 * DAY_MS }), [])
  assert.deepEqual([cardOf(store, turned.id).status, cardOf(store, turned.id).owner.kind], ['pending', 'must'])
})

test('a card made before cards had kinds starts its day when the engine first sees it', () => {
  const { store, job } = yard()
  const j = job('Old question')
  store.put('cards', { id: 'old', companyId: 'co', issueId: j.id, status: 'pending', ...choice('Which colour for the lamp?'), createdAt: new Date(T0 - 5 * DAY_MS).toISOString() }, { position: 0 })
  assert.deepEqual(applyDefaults(store, { now: T0 }), [], 'five days old, and still not applied at once')
  assert.equal(cardOf(store, 'old').owner.applyAt, new Date(T0 + DAY_MS).toISOString())
  assert.equal(applyDefaults(store, { now: T0 + DAY_MS }).length, 1)
})

test('the same question asked again on a job is one card with a count, and its clock is not started again', () => {
  const { store, job } = yard()
  const j = job('Lamp colour')
  const first = ask(store, j, choice('Which colour for the lamp?'))
  const second = ask(store, j, { ...choice('Which  colour for the LAMP?'), idempotencyKey: 'another-key' }, T0 + 5 * HOUR)
  const third = ask(store, j, choice('Which colour for the lamp?'), T0 + 6 * HOUR)
  assert.deepEqual([second.id, third.id], [first.id, first.id])
  assert.equal(store.count('cards'), 1)
  assert.equal(cardOf(store, first.id).asked, 3)
  assert.equal(cardOf(store, first.id).owner.applyAt, new Date(T0 + DAY_MS).toISOString())
  // Another question on the same job is a card of its own; so is the same question once the first was answered.
  ask(store, j, choice('Which size for the lamp?'))
  settleCard(store, j.id, first.id, 'respond', { answers: [{ questionId: 'q', optionIds: ['o1'] }] }, { now: T0 + 7 * HOUR, actor: OWNER })
  ask(store, j, choice('Which colour for the lamp?'), T0 + 8 * HOUR)
  assert.equal(store.count('cards'), 3)
  assert.equal(askText(choice('A?')) === askText({ ...choice('A?'), title: 'A? (asked 2 times)' }), true)
})

test('the digest folds one job\'s cards, and one request\'s same question from several jobs, into one card with a count', () => {
  const { store, job } = yard()
  const parent = job('Harbour lamp')
  const stepA = job('Harbour lamp · Build', { parentId: parent.id })
  const stepB = job('Harbour lamp · Build (round 2)', { parentId: parent.id })
  ask(store, stepA, choice('Which colour for the lamp?'))
  ask(store, stepB, choice('Which colour for the lamp?'), T0 + HOUR)
  ask(store, stepB, choice('Which colour for the lamp?'), T0 + 2 * HOUR)
  const other = job('Pier sign')
  ask(store, other, choice('Which font for the sign?'))
  ask(store, other, choice('Which size for the sign?'))
  const view = digest(store, 'co', { now: T0 + 3 * HOUR })
  assert.equal(store.count('cards'), 4)
  assert.equal(view.cards.length, 2)
  assert.deepEqual(view.cards.map((c) => c.count).sort(), [2, 3])
  assert.equal(view.folded, 3, 'three cards are folded into the two shown')
  assert.equal(view.waiting, 2)
})

test('the digest shows five cards at most, must first, each with its default and when it applies, and says how many more wait', () => {
  const { store, job } = yard()
  for (let n = 0; n < 6; n++) ask(store, job(`Question ${n}`), choice(`Which colour for lamp ${n}?`), T0 + n * HOUR)
  ask(store, job('Font'), choice('Buy the font licence for 49 EUR?'), T0 + 7 * HOUR)
  ask(store, job('Store'), choice('Submit build 14 to the App Store for review?'), T0 + 6 * HOUR)
  const view = digest(store, 'co', { now: T0 + 8 * HOUR })
  assert.equal(DIGEST_CARDS, 5)
  assert.equal(view.cards.length, 5)
  assert.deepEqual(view.cards.map((c) => c.kind), ['must', 'must', 'default', 'default', 'default'])
  // Must: the longest waiting first. Default: the soonest to apply first.
  assert.deepEqual(view.cards.map((c) => c.title), ['Submit build 14 to the App Store for review?', 'Buy the font licence for 49 EUR?', 'Which colour for lamp 0?', 'Which colour for lamp 1?', 'Which colour for lamp 2?'])
  assert.deepEqual([view.cards[0].why, view.cards[0].default, view.cards[0].appliesAt], ['It is a store release', '', null])
  assert.deepEqual([view.cards[2].default, view.cards[2].appliesAt, view.cards[2].why], ['Blue (recommended)', new Date(T0 + DAY_MS).toISOString(), ''])
  assert.deepEqual([view.waiting, view.more, view.must, view.folded], [8, 3, 2, 0])
  assert.match(view.cards[2].job, /^LH-\d+$/)
  // A cancelled job's card is moot and is not counted.
  const gone = store.object("SELECT raw FROM jobs WHERE title = 'Question 5'")
  store.put('jobs', { ...gone, status: 'cancelled' })
  assert.equal(digest(store, 'co', { now: T0 + 8 * HOUR }).waiting, 7)
})

test('an answer applied by default can be taken back for seven days: the card is open again as the owner\'s, and the bot is told', () => {
  const { store, job } = yard()
  const j = job('Lamp colour')
  const card = ask(store, j, choice('Which colour for the lamp?'))
  applyDefaults(store, { now: T0 + DAY_MS })
  const listed = digest(store, 'co', { now: T0 + 2 * DAY_MS })
  assert.deepEqual(listed.applied.map((a) => [a.id, a.answer, a.canReverse]), [[card.id, 'Blue (recommended)', true]])
  assert.equal(listed.cards.length, 0)
  assert.throws(() => reverseDefault(store, j.id, card.id, { now: T0 + 2 * DAY_MS, actor: BOT }), /Only the owner/)
  const back = reverseDefault(store, j.id, card.id, { now: T0 + 2 * DAY_MS, actor: OWNER })
  assert.deepEqual([back.status, back.result, back.owner.kind, back.owner.why], ['pending', null, 'must', 'You took back its default answer'])
  assert.match(store.objects('SELECT raw FROM comments WHERE job_id = ?', j.id).at(-1).body, /took back the answer that was applied by default to "Which colour for the lamp\?" \(Blue \(recommended\)\)/)
  // It waits for the owner now and is never applied by default again.
  assert.deepEqual(applyDefaults(store, { now: T0 + 30 * DAY_MS }), [])
  const again = digest(store, 'co', { now: T0 + 2 * DAY_MS })
  assert.deepEqual([again.cards[0].kind, again.applied.length], ['must', 0])
  assert.throws(() => reverseDefault(store, j.id, card.id, { now: T0 + 2 * DAY_MS, actor: OWNER }), /not applied by default/)

  // After seven days, or once the job is finished, the engine cannot undo it and says so.
  const late = ask(store, job('Late'), choice('Which colour for the pier?'))
  applyDefaults(store, { now: T0 + DAY_MS })
  assert.throws(() => reverseDefault(store, late.issueId, late.id, { now: T0 + DAY_MS + REVERSE_FOR_MS + 1, actor: OWNER }), /seven days to take this answer back are over/)
  const done = ask(store, job('Done'), choice('Which colour for the buoy?'))
  applyDefaults(store, { now: T0 + DAY_MS })
  store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', done.issueId), status: 'done' })
  assert.throws(() => reverseDefault(store, done.issueId, done.id, { now: T0 + 2 * DAY_MS, actor: OWNER }), /job is finished: the engine cannot undo that/)
  assert.equal(digest(store, 'co', { now: T0 + 2 * DAY_MS }).applied.find((a) => a.id === done.id).canReverse, false)
})

/** A gate between two bot steps (its yes can be taken back) and one before a script (its yes cannot). */
const GATED = {
  key: 'gated', inputs: ['brief'], delivers: 'nothing',
  steps: [
    { id: 'draft', kind: 'bot', bot: 'Builder', needs: ['brief'], leaves: ['report'] },
    { id: 'look', kind: 'gate', title: 'A look at the draft', words: 'The draft is ready. Go on to the polish?' },
    { id: 'polish', kind: 'bot', bot: 'Builder', needs: ['report'], leaves: ['report'] },
    { id: 'send', kind: 'gate', title: 'Send it?', words: 'The polished text is ready to send.' },
    { id: 'post', kind: 'script', command: 'post it', timeoutSec: 60 },
  ],
  lines: [
    { from: 'draft', to: 'look', on: 'always' }, { from: 'look', to: 'polish', on: 'pass' },
    { from: 'polish', to: 'send', on: 'always' }, { from: 'send', to: 'post', on: 'pass' }, { from: 'post', to: 'send', on: 'fail' },
  ],
}

test('a gate whose yes starts a bot step is a default card, applied after a day and asked again when taken back; a gate before a script is must', async () => {
  const { store } = yard()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-digest-'))
  saveTrack(store, 'co', GATED, { now: T0, actor: OWNER })
  startRequest(store, 'co', { track: 'gated', title: 'Harbour notice', inputs: { brief: 'b' } }, { now: T0, actor: OWNER })
  const io = { startKeeper() { throw new Error('the script must not start') }, alive: () => false }
  const tick = (now) => tickTracks(store, { dataDir, io, now })
  const finish = (stepId) => {
    const tripId = store.row('SELECT id FROM trips').id
    const jobId = store.objects("SELECT raw FROM trip_steps WHERE trip_id = ? AND step_id = ? AND status = 'working'", tripId, stepId)[0].jobId
    putDocument(store, jobId, 'report', { body: 'The notice, drafted.' }, { now: T0, actor: { agent: 'b1' } })
    store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', jobId), status: 'done' })
  }
  await tick(T0 + 1000)
  finish('draft')
  await tick(T0 + 2000)
  const tripId = store.row('SELECT id FROM trips').id
  const look = store.objects("SELECT raw FROM cards WHERE status = 'pending'")[0]
  assert.deepEqual([look.owner.kind, look.owner.default.answer, look.owner.default.label], ['default', 'accept', 'Yes, polish'])
  // A day on, the yes is applied and the trip goes on by itself.
  assert.equal(applyDefaults(store, { now: T0 + 2000 + DAY_MS }).length, 1)
  await tick(T0 + 3000 + DAY_MS)
  assert.equal(tripView(store, tripId).current, 'polish')
  // Taken back: the polish is let go of and the gate asks again, this time the owner alone.
  reverseDefault(store, look.issueId, look.id, { now: T0 + 2 * DAY_MS, actor: OWNER })
  await tick(T0 + 2 * DAY_MS + 1000)
  assert.equal(tripView(store, tripId).current, 'look')
  const asked = store.objects("SELECT raw FROM cards WHERE status = 'pending'")
  assert.equal(asked.length, 1)
  assert.deepEqual([asked[0].owner.kind, asked[0].owner.why], ['must', 'You took back its default answer'])
  assert.deepEqual(applyDefaults(store, { now: T0 + 40 * DAY_MS }), [])
  // The owner says yes; the next gate stands before a script, which the engine cannot undo: must, never applied.
  settleCard(store, asked[0].issueId, asked[0].id, 'accept', {}, { now: T0 + 3 * DAY_MS, actor: OWNER })
  await tick(T0 + 3 * DAY_MS + 1000)
  finish('polish')
  await tick(T0 + 3 * DAY_MS + 2000)
  const send = store.objects("SELECT raw FROM cards WHERE status = 'pending'")[0]
  assert.deepEqual([send.owner.kind, send.owner.why], ['must', 'Its yes starts "post", which cannot be undone'])
  assert.deepEqual(applyDefaults(store, { now: T0 + 60 * DAY_MS }), [])
  await tick(T0 + 60 * DAY_MS + 1000)
  assert.equal(tripView(store, tripId).current, 'send')
})

test('the engine answers the digest on its own path and takes a default back on the card\'s', async () => {
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-digest-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body) => engine.handle({ method, url, body })
  const id = (await call('GET', '/api/companies')).body[0].id
  const job = (await call('POST', `/api/companies/${id}/issues`, { title: 'Pick a colour' })).body
  const made = await call('POST', `/api/issues/${job.id}/interactions`, choice('Which colour for the lamp?'))
  assert.equal(made.body.owner.kind, 'default')
  const view = (await call('GET', `/api/companies/${id}/digest`)).body
  assert.deepEqual(view.cards.map((c) => [c.kind, c.default, c.count]), [['default', 'Blue (recommended)', 1]])
  assert.equal((await call('POST', `/api/issues/${job.id}/interactions/${made.body.id}/reverse`, {})).status, 409)
  applyDefaults(engine.store, { now: Date.now() + DAY_MS + 1000 })
  const back = await call('POST', `/api/issues/${job.id}/interactions/${made.body.id}/reverse`, {})
  assert.equal(back.status, 200)
  assert.equal(back.body.status, 'pending')
  await engine.stop()
})
