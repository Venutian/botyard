/** Crew signals and the blocked-jobs sweep (day review 2026-11-19, fixes 6 and 7). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../server/engine/store.mjs'
import { createCard, createJob, patchJob } from '../server/engine/write.mjs'
import { retryOf } from '../server/engine/runner.mjs'
import { blockedSweep, crewSignals, dailyBlockedSweep } from '../server/engine/signals.mjs'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const H = 3_600_000
const OWNER = { user: 'local-board' }

function yard() {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Works', issuePrefix: 'NGE', issueCounter: 0 })
  store.put('agents', { id: 'b1', companyId: 'co', name: 'Builder', status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  return store
}
const job = (store, title, status, ageH, extra = {}) => {
  const made = createJob(store, 'co', { title, status: 'todo', ...extra }, { now: NOW - ageH * H, actor: OWNER })
  store.put('jobs', { ...store.object('SELECT raw FROM jobs WHERE id = ?', made.id), status, updatedAt: new Date(NOW - ageH * H).toISOString(), ...(status === 'done' ? { completedAt: new Date(NOW - 2 * H).toISOString() } : {}) })
  return made
}
let seq = 0
const run = (store, jobId, status, hoursAgo, extra = {}) => store.put('runs', { id: `r${++seq}`, companyId: 'co', agentId: 'b1', issueId: jobId, status, startedAt: new Date(NOW - hoursAgo * H).toISOString(), createdAt: new Date(NOW - hoursAgo * H).toISOString(), ...extra })

test('a run after a failed or timed-out run of the same job is a retry; after a good run it is not', () => {
  const store = yard()
  const a = job(store, 'A', 'in_progress', 5)
  assert.equal(retryOf(store, a.id, NOW), null)
  run(store, a.id, 'failed', 4)
  assert.equal(retryOf(store, a.id, NOW), 'r1')
  run(store, a.id, 'succeeded', 3)
  assert.equal(retryOf(store, a.id, NOW), null)
  const b = job(store, 'B', 'in_progress', 5)
  run(store, b.id, 'timed_out', 2)
  assert.equal(retryOf(store, b.id, NOW), `r${seq}`)
})

test('signals count runs per finished job, retries, failed runs, stale steps and the heaviest jobs', () => {
  const store = yard()
  const a = job(store, 'Small', 'done', 6)
  const big = job(store, 'Big one', 'done', 6)
  run(store, a.id, 'succeeded', 5)
  for (let i = 0; i < 9; i++) run(store, big.id, i % 3 ? 'failed' : 'succeeded', 5 - i / 10, i ? { retryOfRunId: 'x' } : {})
  store.put('trip_steps', { id: 's1', tripId: 't', requestId: 'rq', stepId: 'build', status: 'stale', staleAt: new Date(NOW - H).toISOString(), createdAt: new Date(NOW - 3 * H).toISOString() })
  store.put('trip_steps', { id: 's2', tripId: 't', requestId: 'rq', stepId: 'check', status: 'stale', staleAt: new Date(NOW - 40 * H).toISOString(), createdAt: new Date(NOW - 41 * H).toISOString() })
  const s = crewSignals(store, { now: NOW, hours: 24 })
  assert.equal(s.finishedJobs, 2)
  assert.equal(s.runs, 10)
  assert.equal(s.runsPerFinishedJob, 5)
  assert.equal(s.retries, 8)
  assert.equal(s.failedRuns, 6)
  assert.deepEqual(s.staleSteps, { total: 1, byStep: { build: 1 } })
  assert.deepEqual(s.heaviestJobs.map((h) => [h.title, h.runs]), [['Big one', 9]])
})

test('the blocked sweep closes dead track steps, unblock loops and unread digests, and only lists the rest', () => {
  const store = yard()
  const target = job(store, 'Rule on landing: NGE-9', 'blocked', 30)
  const loop = job(store, `Unblock: ${target.identifier}: Gideon ruled in NGE-1 and then`, 'blocked', 30)
  const digest = job(store, 'Crew digest 18 Nov: 2 to act on', 'blocked', 30)
  const orphan = job(store, 'Build', 'blocked', 30, { description: 'x\n\nTRACK STEP: 00000000-0000-0000-0000-000000000000/build/1' })
  const plain = job(store, 'Plan: money path', 'blocked', 30)
  const fresh = job(store, 'Crew digest today', 'blocked', 2)
  const asking = job(store, 'Needs the owner', 'blocked', 30)
  createCard(store, asking.id, { kind: 'request_confirmation', title: 'q', payload: { prompt: 'ok?' } }, { now: NOW - 29 * H, actor: { agent: 'b1' } })
  const look = blockedSweep(store, { now: NOW, apply: false })
  const kinds = Object.fromEntries(look.items.map((i) => [i.job, i.kind]))
  assert.equal(kinds[loop.identifier], 'close')
  assert.equal(kinds[digest.identifier], 'close')
  assert.equal(kinds[orphan.identifier], 'close')
  assert.equal(kinds[plain.identifier], 'ask')
  assert.equal(kinds[target.identifier], 'ask')
  assert.equal(kinds[fresh.identifier], undefined)
  assert.equal(kinds[asking.identifier], undefined)
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', loop.id).status, 'blocked')
  const done = blockedSweep(store, { now: NOW, apply: true })
  assert.equal(done.closed, 3)
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', loop.id).status, 'cancelled')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', plain.id).status, 'blocked')
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', target.id).status, 'blocked')
})

test('the daily sweep runs once in 24 hours', () => {
  const store = yard()
  job(store, 'Crew digest', 'blocked', 30)
  const state = {}
  assert.equal(dailyBlockedSweep(store, state, { now: NOW }).closed, 1)
  assert.equal(dailyBlockedSweep(store, state, { now: NOW + 5 * H }), null)
  assert.equal(dailyBlockedSweep(store, {}, { now: NOW + 5 * H }), null)
  assert.notEqual(dailyBlockedSweep(store, state, { now: NOW + 25 * H }), null)
})

import { addComment, putDocument } from '../server/engine/write.mjs'
import { spinning } from '../server/engine/runner.mjs'

test('a job whose last four runs ended well and left nothing is stopped, not run a fifth time', () => {
  const store = yard()
  const a = job(store, 'Loop', 'in_progress', 10)
  const base = () => store.object('SELECT raw FROM jobs WHERE id = ?', a.id)
  for (let i = 0; i < 4; i++) run(store, a.id, 'succeeded', 8 - i, { finishedAt: new Date(NOW - (8 - i) * H + 20_000).toISOString() })
  assert.equal(spinning(store, base()), true)
  // A comment since the first of them, or a failed run among them, ends the streak.
  addComment(store, a.id, { body: 'noted' }, { now: NOW - 5 * H, actor: OWNER, quiet: true })
  assert.equal(spinning(store, base()), false)
  const b = job(store, 'Fine', 'in_progress', 10)
  for (let i = 0; i < 4; i++) run(store, b.id, i === 2 ? 'failed' : 'succeeded', 8 - i, { finishedAt: new Date(NOW - (8 - i) * H + 20_000).toISOString() })
  assert.equal(spinning(store, store.object('SELECT raw FROM jobs WHERE id = ?', b.id)), false)
  const c = job(store, 'Working', 'in_progress', 10)
  for (let i = 0; i < 4; i++) run(store, c.id, 'succeeded', 8 - i, { finishedAt: new Date(NOW - (8 - i) * H + 20_000).toISOString() })
  putDocument(store, c.id, 'notes', { body: 'x' }, { now: NOW - 6 * H, actor: { agent: 'b1' } })
  assert.equal(spinning(store, store.object('SELECT raw FROM jobs WHERE id = ?', c.id)), false)
})
