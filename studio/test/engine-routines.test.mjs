/** Routines in Botyard's engine: a timetable is read in its own time zone, and a routine starts one job at a time. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../server/engine/store.mjs'
import { nextTime, runRoutine, tickRoutines } from '../server/engine/routines.mjs'

const at = (text) => Date.parse(text)

test('a timetable gives its next time in the routine\'s own time zone, across the change of clocks', () => {
  // Every night at 03:00 in Stockholm: 02:00 UTC in winter, 01:00 UTC in summer.
  assert.equal(nextTime('0 3 * * *', at('2026-11-12T12:00:00Z'), 'Europe/Stockholm'), at('2026-11-13T02:00:00Z'))
  assert.equal(nextTime('0 3 * * *', at('2026-07-01T12:00:00Z'), 'Europe/Stockholm'), at('2026-07-02T01:00:00Z'))
  // Weekdays at 07:00: from a Friday afternoon the next is Monday.
  assert.equal(nextTime('0 7 * * 1-5', at('2026-11-13T15:00:00Z'), 'UTC'), at('2026-11-16T07:00:00Z'))
  // Mondays at 04:00, and Sunday written as 7.
  assert.equal(nextTime('0 4 * * 1', at('2026-11-12T12:00:00Z'), 'UTC'), at('2026-11-16T04:00:00Z'))
  assert.equal(nextTime('30 9 * * 7', at('2026-11-12T12:00:00Z'), 'UTC'), at('2026-11-15T09:30:00Z'))
  assert.equal(nextTime('*/15 * * * *', at('2026-11-12T12:07:30Z'), 'UTC'), at('2026-11-12T12:15:00Z'))
  for (const bad of ['', 'every night', '61 3 * * *', '0 3 * *', '0 3 * * 9']) assert.equal(nextTime(bad, 0, 'UTC'), null, bad)
  assert.equal(nextTime('0 3 * * *', 0, 'Not/AZone'), null)
})

function studio() {
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 10 })
  store.put('agents', { id: 'lead', companyId: 'co', name: 'Lead', status: 'idle', adapterType: 'claude_local', adapterConfig: {} })
  store.put('routines', { id: 'r1', companyId: 'co', title: 'Status', description: 'On each game as a table', assigneeAgentId: 'lead', priority: 'medium', status: 'active' }, { position: 0 })
  store.put('routine_triggers', { id: 't1', routineId: 'r1', kind: 'schedule', enabled: true, cronExpression: '0 3 * * *', timezone: 'UTC', nextRunAt: '2026-11-13T03:00:00.000Z' })
  return store
}

test('a routine starts its job on time, once, and not on top of one still open', () => {
  const store = studio()
  assert.equal(tickRoutines(store, { now: at('2026-11-13T02:59:00Z') }).length, 0, 'not yet')
  const fired = tickRoutines(store, { now: at('2026-11-13T03:00:10Z') })
  assert.equal(fired.length, 1)
  const job = store.object('SELECT raw FROM jobs WHERE id = ?', fired[0].linkedIssueId)
  assert.equal(job.title, 'Status')
  assert.equal(job.identifier, 'LH-11')
  assert.equal(store.object("SELECT raw FROM wakes WHERE status = 'queued'").agentId, 'lead', 'its bot is woken')
  assert.equal(store.object('SELECT raw FROM routine_triggers WHERE id = ?', 't1').nextRunAt, '2026-11-14T03:00:00.000Z')
  assert.equal(tickRoutines(store, { now: at('2026-11-13T03:00:40Z') }).length, 0, 'once')
  // The next night its job is still open: it is not started again on top of it.
  const again = tickRoutines(store, { now: at('2026-11-14T03:00:05Z') })
  assert.equal(again[0].status, 'coalesced')
  assert.equal(store.count('jobs'), 1)
  // A time missed while the engine was off is skipped, and the timetable moves on.
  assert.equal(tickRoutines(store, { now: at('2026-11-17T09:00:00Z') }).length, 0)
  assert.equal(store.object('SELECT raw FROM routine_triggers WHERE id = ?', 't1').nextRunAt, '2026-11-18T03:00:00.000Z')
  // A paused routine does not start.
  store.put('routines', { ...store.object("SELECT raw FROM routines WHERE id = 'r1'"), status: 'paused' }, { position: 0 })
  assert.equal(tickRoutines(store, { now: at('2026-11-18T03:00:05Z') }).length, 0)
})

test('a routine is made, given a timetable, rescheduled, paused, switched back on and removed through the API', async () => {
  const { startEngine } = await import('../server/engine/main.mjs')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const engine = await startEngine({ dataDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-routines-')), 'data'), runs: false, log: () => {} })
  const call = (method, url, body) => engine.handle({ method, url, body })
  const ok = async (method, url, body) => { const out = await call(method, url, body); assert.ok(out.status < 300, `${method} ${url} → ${out.status} ${JSON.stringify(out.body)}`); return out.body }
  const id = (await ok('GET', '/api/companies'))[0].id
  const bot = await ok('POST', `/api/companies/${id}/agents`, { name: 'Lena The Lead', role: 'ceo' })
  const project = await ok('POST', `/api/companies/${id}/projects`, { name: 'Game' })

  assert.equal((await call('POST', `/api/companies/${id}/routines`, { title: 'No bot' })).status, 400)
  assert.equal((await call('POST', `/api/companies/${id}/routines`, { title: '', assigneeAgentId: bot.id })).status, 400)
  const routine = await ok('POST', `/api/companies/${id}/routines`, { title: 'Morning status', description: 'Say where things stand.', assigneeAgentId: bot.id, projectId: project.id })
  assert.equal(routine.status, 'active')
  assert.deepEqual(routine.triggers, [])
  assert.equal(routine.assignee.name, 'Lena The Lead')

  assert.equal((await call('POST', `/api/routines/${routine.id}/triggers`, { kind: 'schedule', cronExpression: 'every morning' })).status, 400)
  assert.equal((await call('POST', `/api/routines/${routine.id}/triggers`, { kind: 'schedule', cronExpression: '0 8 * * *', timezone: 'Mars/Olympus' })).status, 400)
  assert.equal((await call('POST', `/api/routines/${routine.id}/triggers`, { kind: 'webhook' })).status, 400)
  const trigger = await ok('POST', `/api/routines/${routine.id}/triggers`, { kind: 'schedule', cronExpression: '0 8 * * *', timezone: 'Europe/Stockholm' })
  assert.equal(trigger.enabled, true)
  assert.ok(Date.parse(trigger.nextRunAt) > Date.now())
  // The list is what the map reads: the routine with its timetable as it is now.
  let listed = (await ok('GET', `/api/companies/${id}/routines`))[0]
  assert.equal(listed.triggers[0].cronExpression, '0 8 * * *')
  assert.equal(listed.triggers[0].nextRunAt, trigger.nextRunAt)

  // Rescheduled: another hour, and the next time moves with it.
  const moved = await ok('PATCH', `/api/routine-triggers/${trigger.id}`, { cronExpression: '30 17 * * 1-5' })
  assert.equal(moved.timezone, 'Europe/Stockholm')
  assert.notEqual(moved.nextRunAt, trigger.nextRunAt)
  assert.equal((await ok('GET', `/api/routines/${routine.id}`)).triggers[0].cronExpression, '30 17 * * 1-5')
  assert.equal((await call('PATCH', `/api/routine-triggers/${trigger.id}`, { cronExpression: '99 * * * *' })).status, 400)

  // When its time comes it starts its job; paused, it does not.
  const due = Date.parse(moved.nextRunAt) + 1000
  assert.equal(tickRoutines(engine.store, { now: due }).length, 1)
  const job = (await ok('GET', `/api/companies/${id}/issues`))[0]
  assert.equal(job.title, 'Morning status')
  assert.equal(job.assigneeAgentId, bot.id)
  listed = (await ok('GET', `/api/companies/${id}/routines`))[0]
  assert.equal(listed.lastRun.linkedIssueId, job.id)
  assert.ok(Date.parse(listed.triggers[0].nextRunAt) > due, 'the list shows the next time, not the one that passed')
  await ok('PATCH', `/api/issues/${job.id}`, { status: 'done' })

  const paused = await ok('PATCH', `/api/routines/${routine.id}`, { status: 'paused', title: 'Evening status' })
  assert.equal(paused.status, 'paused')
  const later = Date.parse(listed.triggers[0].nextRunAt) + 1000
  assert.equal(tickRoutines(engine.store, { now: later }).length, 0)
  // Switched back on long after, it waits for its next time and does not make up for the ones it missed.
  const back = Date.parse(listed.triggers[0].nextRunAt) + 5 * 24 * 3600_000
  engine.store.put('routines', { ...engine.store.object('SELECT raw FROM routines WHERE id = ?', routine.id), status: 'active' }, { position: 0 })
  assert.equal(tickRoutines(engine.store, { now: back }).length, 0, 'a time missed by days is skipped')

  // Every change is kept.
  const revisions = await ok('GET', `/api/routines/${routine.id}/revisions`)
  assert.deepEqual(revisions.map((r) => r.changeSummary), ['Created routine', 'Added a timetable', 'Changed its timetable', 'Set to paused'])
  assert.equal(revisions.at(-1).title, 'Evening status')
  assert.equal(revisions.at(-1).snapshot.triggers.length, 1)

  // A timetable is taken off; the routine is removed: gone from what the map lists, its job still there.
  await ok('DELETE', `/api/routine-triggers/${trigger.id}`)
  assert.deepEqual((await ok('GET', `/api/routines/${routine.id}`)).triggers, [])
  const removed = await ok('DELETE', `/api/routines/${routine.id}`)
  assert.equal(removed.status, 'archived')
  assert.equal((await call('POST', `/api/routines/${routine.id}/run`, {})).status, 409)
  assert.equal((await ok('GET', `/api/issues/${job.id}`)).status, 'done')
  await engine.stop()
})
