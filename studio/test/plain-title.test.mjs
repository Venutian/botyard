// A job is shown to the owner by what was done, without the crew's own bookkeeping in its name.

import test from 'node:test'
import assert from 'node:assert/strict'
import { plainTitle } from '../server/lib/engine.mjs'

test('a job title loses its numbers, round counters and notes to the scripts', () => {
  assert.equal(plainTitle('Check LH-468: Signal box art: fix invalid SVGs and typecheck'), 'Checked: Signal box art: fix invalid SVGs and typecheck')
  assert.equal(plainTitle('Check LH-454 (Lead): Quay: real style guides, strict checker'), 'Checked: Quay: real style guides, strict checker')
  assert.equal(plainTitle('Fix 1 of Website: true Lighthouse privacy page'), 'Fixed: Website: true Lighthouse privacy page')
  assert.equal(plainTitle('Website: real mobile speed (restart)'), 'Website: real mobile speed')
  assert.equal(plainTitle('LH-134 Roof order test'), 'Roof order test')
  assert.equal(plainTitle('Ruling: Harbour M9, how is the 14 ms frame line judged?'), 'Decision: Harbour M9, how is the 14 ms frame line judged?')
  assert.equal(plainTitle('lighthouse: fix store-shots tool'), 'Lighthouse: fix store-shots tool')
  assert.equal(plainTitle(''), '')
})
