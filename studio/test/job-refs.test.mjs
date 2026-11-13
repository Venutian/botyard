import assert from 'node:assert/strict'
import test from 'node:test'
import { refOf } from '../server/lib/engine.mjs'

const projects = new Map([['b', 'Lighthouse and Beacon'], ['n', 'Quay'], ['s', 'Botyard'], ['a', 'Harbour']])

test('a job is read by its project code with the engine\'s number', () => {
  assert.equal(refOf({ identifier: 'LH-313', projectId: 's', title: 'The app cannot reach the studio' }, projects), 'LH-313')
  assert.equal(refOf({ identifier: 'LH-307', projectId: 'n', title: 'Phase 1b' }, projects), 'LH-307')
  assert.equal(refOf({ identifier: 'LH-322', projectId: 'a', title: 'M9 critic read' }, projects), 'LH-322')
  assert.equal(refOf({ identifier: 'LH-304', projectId: 'b', title: 'Lighthouse map' }, projects), 'LH-304')
  assert.equal(refOf({ identifier: 'LH-305', projectId: 'b', title: 'Beacon scorecard' }, projects), 'LH-305')
  assert.equal(refOf({ identifier: 'LH-30', title: 'Continue with what is left' }, projects), 'LH-30')
  assert.equal(refOf({ title: 'no number yet' }, projects), '')
})

test('a job keeps its code when its project could not be read this time', async () => {
  const { refOf } = await import('../server/lib/engine.mjs')
  const job = { identifier: 'LH-9719', projectId: 'p-harbour', title: 'Harbour: graves look hand-built' }
  assert.equal(refOf(job, new Map([['p-harbour', 'Harbour']])), 'LH-9719')
  assert.equal(refOf(job, new Map()), 'LH-9719')
})
