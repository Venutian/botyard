import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cardKey, markCards, readCards, withCardState } from '../server/lib/cards.mjs'

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cards-')), 'cards.json')

test('a card is keyed by what it is, and a chat card by its questions, not its words', () => {
  assert.equal(cardKey({ kind: 'approval', id: 'a1', title: 'Old words' }), 'approval:a1')
  assert.equal(cardKey({ kind: 'approval', id: 'a1', title: 'New words' }), 'approval:a1')
  const two = cardKey({ kind: 'question', id: 'chat', asks: [{ id: 'q2' }, { id: 'q1' }] })
  assert.equal(two, 'question:chat:q1,q2')
  assert.notEqual(cardKey({ kind: 'question', id: 'chat', asks: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] }), two)
  assert.equal(cardKey({ kind: 'failed', id: '', title: '3 failed runs' }), 'failed:3 failed runs')
})

test('read and archived marks are kept, undone, and shown on the cards', () => {
  const file = temp()
  const cards = [{ kind: 'approval', id: 'a1', title: 'Spend' }, { kind: 'review', id: 'r1', title: 'Look' }]
  markCards(['approval:a1'], { read: true }, { file, now: 1000 })
  markCards('review:r1', { archived: true }, { file, now: 1000 })
  let shown = withCardState(cards, readCards(file))
  assert.deepEqual(shown.map((c) => [c.key, c.read, c.archived]), [['approval:a1', true, false], ['review:r1', true, true]])
  markCards(['review:r1'], { archived: false }, { file, now: 2000 })
  markCards(['approval:a1'], { read: false }, { file, now: 2000 })
  shown = withCardState(cards, readCards(file))
  assert.deepEqual(shown.map((c) => [c.read, c.archived]), [[false, false], [true, false]])
})

test('marks older than two months are dropped, and nonsense is refused', () => {
  const file = temp()
  markCards(['old'], { archived: true }, { file, now: 0 })
  markCards(['new'], { archived: true }, { file, now: 61 * 24 * 3600 * 1000 })
  assert.deepEqual(Object.keys(readCards(file).archived), ['new'])
  assert.throws(() => markCards([], { read: true }, { file }), /No card/)
  assert.deepEqual(readCards(path.join(path.dirname(file), 'missing.json')), { read: {}, archived: {} })
})
