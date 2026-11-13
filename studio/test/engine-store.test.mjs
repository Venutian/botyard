/**
 * Botyard's own store: the file is made on first use, opens again with what was put in it, and writing
 * the same thing twice leaves one row. Every row gives back the object it was made from, untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, TABLES, openStore, stamp } from '../server/engine/store.mjs'

const JOB = '55555555-5555-4555-8555-555555555555'
const RUN = '66666666-6666-4666-8666-666666666666'
const FREE = '22222222-2222-4222-8222-222222222222'

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engine-store-'))
const job = (extra = {}) => ({ id: JOB, companyId: 'co', identifier: 'LH-7', issueNumber: 7, title: 'Fix the map', description: 'Make it fast', status: 'todo', priority: 'high', assigneeAgentId: FREE, assigneeAdapterOverrides: { model: 'small' }, createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z', nested: { kept: ['as', 'is'] }, ...extra })

test('a new store has every table, in write-ahead mode, and says which schema it is', () => {
  const dir = folder()
  const store = openStore(path.join(dir, 'deep', 'studio.db'))
  const names = store.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name)
  for (const table of [...Object.keys(TABLES), 'meta']) assert.ok(names.includes(table), `${table} is missing`)
  assert.equal(store.row('PRAGMA journal_mode').journal_mode, 'wal')
  assert.equal(store.meta('schema_version'), String(SCHEMA_VERSION))
  const indexes = store.rows("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name)
  for (const index of ['jobs_by_company_id_status', 'jobs_by_project_id', 'jobs_by_assignee_agent_id', 'jobs_by_parent_id', 'jobs_by_updated_at', 'comments_by_job_id_position', 'runs_by_agent_id_created_at', 'runs_by_job_id_created_at', 'runs_by_company_id_created_at']) {
    assert.ok(indexes.includes(index), `${index} is missing`)
  }
  store.close()
  fs.rmSync(dir, { recursive: true })
})

test('a store opens again with what was put in it', () => {
  const dir = folder()
  const file = path.join(dir, 'studio.db')
  let store = openStore(file)
  store.put('jobs', job(), { list_raw: { id: JOB, lastActivityAt: '2026-11-11T12:00:00.000Z' } })
  store.setMeta('company_id', 'co')
  store.close()
  store = openStore(file)
  assert.deepEqual(store.object('SELECT raw FROM jobs WHERE id = ?', JOB), job())
  assert.equal(store.meta('company_id'), 'co')
  assert.equal(store.count('jobs'), 1)
  store.close()
  fs.rmSync(dir, { recursive: true })
})

test('a job keeps its object whole and its columns beside it', () => {
  const store = openStore(':memory:')
  store.put('jobs', job({ conversationAgentId: FREE, hiddenAt: null, parentId: 'parent', projectId: 'project', executionWorkspaceId: 'folder' }), { list_raw: { id: JOB, lastActivityAt: '2026-11-11T12:00:00Z' } })
  const row = store.row('SELECT * FROM jobs WHERE id = ?', JOB)
  assert.equal(row.identifier, 'LH-7')
  assert.equal(row.issue_number, 7)
  assert.equal(row.status, 'todo')
  assert.equal(row.assignee_agent_id, FREE)
  assert.equal(row.conversation_agent_id, FREE)
  assert.equal(row.parent_id, 'parent')
  assert.equal(row.project_id, 'project')
  assert.equal(row.execution_workspace_id, 'folder')
  assert.equal(row.assignee_adapter_overrides, '{"model":"small"}')
  assert.equal(row.last_activity_at, '2026-11-11T12:00:00.000Z')
  assert.deepEqual(JSON.parse(row.raw).nested, { kept: ['as', 'is'] })
  assert.deepEqual(JSON.parse(row.list_raw), { id: JOB, lastActivityAt: '2026-11-11T12:00:00Z' })
  store.close()
})

test('writing the same row twice leaves one row with the newer values', () => {
  const store = openStore(':memory:')
  store.put('jobs', job())
  store.put('jobs', job({ status: 'done', title: 'Fixed the map' }))
  store.put('jobs', job({ status: 'done', title: 'Fixed the map' }))
  assert.equal(store.count('jobs'), 1)
  assert.deepEqual(store.row('SELECT status, title FROM jobs').status, 'done')
  assert.equal(store.object('SELECT raw FROM jobs').title, 'Fixed the map')
  assert.throws(() => store.put('jobs', { title: 'No id' }), /needs its id/)
  assert.throws(() => store.put('nothing', { id: 'x' }), /no table called nothing/)
  store.close()
})

test('a run page of a megabyte is stored small and comes back exactly', () => {
  const store = openStore(':memory:')
  const page = { id: RUN, companyId: 'co', agentId: FREE, issueId: JOB, status: 'succeeded', usageJson: { inputTokens: 10 }, resultJson: { summary: 'Done' }, sessionIdBefore: 's1', sessionIdAfter: 's2', logRef: 'co/free/run.ndjson', logBytes: 1234, retryOfRunId: null, invocationSource: 'assignment', createdAt: '2026-11-11T10:00:00.000Z', contextSnapshot: { taskMarkdown: 'The same line again and again.\n'.repeat(40_000) } }
  store.put('runs', page, { summary_raw: { id: RUN, status: 'succeeded' }, live_raw: null })
  const row = store.row('SELECT raw, usage_json, session_id_after, log_bytes, job_id, summary_raw, live_raw FROM runs')
  assert.ok(row.raw.length < 50_000, 'the page is compressed')
  assert.equal(row.usage_json, '{"inputTokens":10}')
  assert.equal(row.session_id_after, 's2')
  assert.equal(row.log_bytes, 1234)
  assert.equal(row.job_id, JOB)
  assert.equal(row.live_raw, null)
  assert.deepEqual(store.object('SELECT raw FROM runs WHERE id = ?', RUN), page)
  store.close()
})

test('database rows with underscore names fill the same columns as API objects', () => {
  const store = openStore(':memory:')
  store.put('wakes', { id: 'w1', agent_id: FREE, source: 'assignment', reason: 'issue_assigned', status: 'completed', run_id: RUN, requested_at: '2026-11-11 10:00:00.5+00' })
  store.put('usage', { id: 'u1', company_id: 'co', agent_id: FREE, heartbeat_run_id: RUN, provider: 'anthropic', model: 'sonnet', input_tokens: 10, cached_input_tokens: 90, output_tokens: 5, cost_cents: 0, cost_cents_text: '0.0000000', occurred_at: '2026-11-11T10:00:00+00:00' })
  const wake = store.row('SELECT * FROM wakes')
  assert.equal(wake.agent_id, FREE)
  assert.equal(wake.requested_at, '2026-11-11T10:00:00.500Z')
  const usage = store.row('SELECT * FROM usage')
  assert.equal(usage.run_id, RUN)
  assert.equal(usage.cached_input_tokens, 90)
  assert.equal(usage.cost_cents, '0.0000000')
  assert.equal(usage.occurred_at, '2026-11-11T10:00:00.000Z')
  assert.equal(stamp('not a date'), null)
  assert.equal(stamp(null), null)
  store.close()
})

test('the rows under a job are swapped as a set and keep the order they came in', () => {
  const store = openStore(':memory:')
  const comment = (id, body) => ({ id, issueId: JOB, body, createdAt: '2026-11-11T10:00:00.000Z' })
  store.replace('comments', 'job_id', JOB, [comment('c3', 'newest'), comment('c2', 'middle'), comment('c1', 'oldest')])
  store.put('comments', { id: 'other', issueId: 'another job', body: 'stays' }, { position: 0 })
  assert.deepEqual(store.objects('SELECT raw FROM comments WHERE job_id = ? ORDER BY position', JOB).map((c) => c.id), ['c3', 'c2', 'c1'])
  store.replace('comments', 'job_id', JOB, [comment('c4', 'newer still'), comment('c3', 'newest')])
  assert.deepEqual(store.objects('SELECT raw FROM comments WHERE job_id = ? ORDER BY position', JOB).map((c) => c.id), ['c4', 'c3'])
  assert.equal(store.count('comments'), 3)
  assert.throws(() => store.replace('comments', 'nope', JOB, []), /no column nope/)
  store.close()
})

test('a failed write leaves nothing half done, and one column is set without touching the rest', () => {
  const store = openStore(':memory:')
  store.put('jobs', job())
  assert.equal(store.count('jobs'), 1)
  assert.throws(() => store.tx(() => {
    store.put('jobs', job({ id: 'half', identifier: 'LH-2' }))
    throw new Error('stop')
  }), /stop/)
  assert.equal(store.count('jobs'), 1)
  store.patch('jobs', JOB, { list_raw: { id: JOB, short: true } })
  assert.deepEqual(JSON.parse(store.row('SELECT list_raw FROM jobs').list_raw), { id: JOB, short: true })
  assert.throws(() => store.patch('jobs', JOB, { nope: 1 }), /no column nope/)
  store.close()
})

test('a store written by a newer Botyard is refused, not guessed at', () => {
  const dir = folder()
  const file = path.join(dir, 'studio.db')
  openStore(file).close()
  const db = new DatabaseSync(file)
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1))
  db.close()
  assert.throws(() => openStore(file), /newer Botyard/)
  fs.rmSync(dir, { recursive: true })
})
