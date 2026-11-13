/**
 * The library and timers read straight off this machine: the crew's timers in plain words, soonest
 * first, and Researcher's ledger read only from inside its own folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTimers, timerView } from '../server/lib/library.mjs'

test('the helpers that run by themselves are listed soonest first, a stopped one last, and a kept-running one not at all', async () => {
  const timers = await readTimers({
    run: async () => ({ state: 'on', jobs: [
      { name: 'research', kind: 'timer', what: 'Researcher looks for money-making ideas', on: true, nextAt: 1794421200000, lastEnd: null },
      { name: 'health', kind: 'timer', what: 'Tells the lead what is wrong', on: true, nextAt: 1794412493737, lastStart: 1794410668000, lastEnd: 1794410668396 },
      { name: 'review-guard', kind: 'timer', what: 'Moves finished jobs on', on: false, nextAt: 1794412000000, lastEnd: 1794411424727 },
      { name: 'sessions', kind: 'keeper', what: 'Kept running', on: true },
      { nonsense: true },
    ] }),
  })
  assert.deepEqual(timers.map((t) => t.id), ['health', 'research', 'review-guard'])
  assert.equal(timers[1].name, 'Researcher looks for money-making ideas')
  assert.equal(timers[1].last, null)
  assert.equal(timers[0].last, 1794410668396)
  assert.equal(timers[2].next, null, 'one that is switched off has no next time')
  assert.deepEqual(timerView(), [])
  assert.deepEqual(timerView(null), [])
})
