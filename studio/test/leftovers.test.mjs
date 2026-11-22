/** Programs an ended run left running are stopped ten minutes after it, killed a minute later; nothing else is touched. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../server/engine/store.mjs'
import { GRACE_MS, leftoverSweeper, stopLeftovers } from '../server/engine/leftovers.mjs'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const runRow = (id, status, finishedAt) => ({ id, companyId: 'co', agentId: 'b', status, createdAt: ago(3_600_000), updatedAt: ago(0), finishedAt })
const proc = (pid, runId, cmd = '/opt/brave/brave') => [pid, { pid, cmd: [cmd, '--headless'], env: runId ? { BOTYARD_RUN_ID: runId } : {} }]

test('only programs of runs that ended ten minutes ago or more are stopped, shared servers and unknown runs stay', () => {
  const store = openStore(':memory:')
  store.put('runs', runRow('old', 'succeeded', ago(GRACE_MS + 1000)))
  store.put('runs', runRow('fresh', 'failed', ago(60_000)))
  store.put('runs', runRow('live', 'running', null))
  const processes = new Map([proc(1, 'old'), proc(2, 'old', '/usr/bin/adb'), proc(3, 'fresh'), proc(4, 'live'), proc(5, 'not-in-store'), proc(6, null), proc(7, 'old')])
  const sent = []
  const told = new Map()
  const out = stopLeftovers(store, { processes, now: NOW, told, kill: (pid, sig) => sent.push([pid, sig]), self: 7 })
  assert.deepEqual(sent, [[1, 'SIGTERM']])
  assert.deepEqual(out.map((o) => [o.pid, o.runId, o.what]), [[1, 'old', 'brave']])
  // Told once: nothing again before a minute, then the kill.
  assert.deepEqual(stopLeftovers(store, { processes, now: NOW + 30_000, told, kill: (pid, sig) => sent.push([pid, sig]), self: 7 }), [])
  stopLeftovers(store, { processes, now: NOW + 61_000, told, kill: (pid, sig) => sent.push([pid, sig]), self: 7 })
  assert.deepEqual(sent.at(-1), [1, 'SIGKILL'])
  // Gone: forgotten.
  stopLeftovers(store, { processes: new Map(), now: NOW + 120_000, told, kill: () => {} })
  assert.equal(told.size, 0)
})

test('the engine sweeps at most every five minutes, and only on Linux', () => {
  const store = openStore(':memory:')
  store.put('runs', runRow('old', 'succeeded', ago(GRACE_MS + 1000)))
  const processes = new Map([proc(1, 'old')])
  const sent = []
  const sweep = leftoverSweeper({ platform: 'linux' })
  const go = (now) => sweep(store, { now, processes, kill: (pid, sig) => sent.push(sig), self: 0 })
  go(NOW); go(NOW + 60_000); go(NOW + 4 * 60_000)
  assert.deepEqual(sent, ['SIGTERM'], 'once in the first five minutes')
  go(NOW + 5 * 60_000)
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'], 'the next sweep kills what did not stop')
  assert.deepEqual(leftoverSweeper({ platform: 'win32' })(store, { now: NOW, processes, kill: () => sent.push('x') }), [])
})
