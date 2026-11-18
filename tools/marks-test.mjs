/** The phone's review reckoning (src/marks.ts): lines of a selection, a box from a drag, and the review sent. */
import assert from 'node:assert/strict'
import { boxOf, linesOf, quoteOf, reviewOf, whereOf } from '../src/marks.ts'

const text = 'First line\nSecond line\n\nFourth'
assert.deepEqual(linesOf(text, 6, 17), { line: 1, lineEnd: 2 })
assert.deepEqual(linesOf(text, 11, 23), { line: 2, lineEnd: 2 }, 'a selection to the start of the next line ends on the line before')
assert.deepEqual(linesOf(text, 25, 31), { line: 4, lineEnd: 4 })
assert.equal(quoteOf(text, 17, 6), 'line\nSecond')
assert.equal(quoteOf(text, 22, 24), '')

const size = { width: 300, height: 200 }
assert.deepEqual(boxOf({ x: 150, y: 100 }, { x: 0, y: 0 }, size), { x: 0, y: 0, w: 0.5, h: 0.5 })
assert.deepEqual(boxOf({ x: 150, y: 100 }, { x: 154, y: 103 }, size), { x: 0.5, y: 0.5, w: 0, h: 0 }, 'a short drag is a point')
assert.deepEqual(boxOf({ x: -20, y: 250 }, { x: 600, y: 100 }, size), { x: 0, y: 0.5, w: 1, h: 0.5 }, 'a drag off the picture stops at its edge')

assert.equal(whereOf({ n: 1, kind: 'text', pieceId: 'a', quote: 'x', line: 2, lineEnd: 4, comment: '' }), 'lines 2–4')
assert.equal(whereOf({ n: 1, kind: 'picture', pieceId: 'a', box: { x: 0, y: 0, w: 0, h: 0 }, comment: '' }), 'a point on the picture')

const src = {
  jobId: 'j1', ref: 'HAR-1', title: 'Shop', chat: false, bot: 'Builder', projectId: null, gate: null,
  pieces: [{ id: 'brief', kind: 'brief', ref: '', title: 'The brief' }, { id: 'picture:p', kind: 'picture', ref: 'p', title: 'shot.png' }],
}
const marks = [
  { n: 1, kind: 'text', pieceId: 'brief', quote: 'Shop', line: 1, lineEnd: 1, comment: 'Name it' },
  { n: 2, kind: 'picture', pieceId: 'picture:p', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, comment: 'Too dark' },
]
const both = reviewOf(src, marks, ' fine ', 'back', 'brief')
assert.deepEqual(both.piece, { kind: 'work', ref: '', title: 'HAR-1 Shop' })
assert.equal(both.note, 'fine')
assert.deepEqual(both.marks[1], { kind: 'picture', comment: 'Too dark', piece: { kind: 'picture', ref: 'p' }, attachmentId: 'p', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
assert.equal(reviewOf(src, marks.slice(0, 1), '', 'back', 'brief').piece.kind, 'brief')
assert.deepEqual(reviewOf({ ...src, gate: { tripId: 't', stepId: 'look', title: 'Look', before: [] } }, [], 'x', 'approve', 'brief', 'draft').gate, { tripId: 't', to: 'draft' })
console.log('marks: ok')
