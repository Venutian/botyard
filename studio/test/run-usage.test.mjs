/**
 * A run is booked with its own share of a resumed session: Claude prints the session's running cost,
 * Codex the thread's running tokens (run-usage.mjs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../server/engine/store.mjs'
import { adapterOfModel, convertBookedRuns, lastPrinted, ownShare } from '../server/engine/run-usage.mjs'
import { finishRun } from '../server/engine/runner.mjs'
import { runLogsDir } from '../server/engine/names.mjs'

const CO = 'co-1'
const BOT = 'bot-1'

test('Claude: the cost is the rise over the last run of the session, the tokens are the run\'s own', () => {
  const own = ownShare('claude_local', { inputTokens: 900, cachedInputTokens: 50_000, outputTokens: 300, costUsd: 94.25 }, { inputTokens: 15_000, cachedInputTokens: 2_800_000, outputTokens: 5000, costUsd: 94.07 })
  assert.equal(own.costUsd, 0.18)
  assert.equal(own.inputTokens, 900)
  assert.equal(own.cachedInputTokens, 50_000)
  assert.equal(own.outputTokens, 300)
  assert.equal(own.perRun, true)
  assert.deepEqual(own.reported, { costUsd: 94.25 })
})

test('Codex: the tokens are the rise over the last run of the thread', () => {
  const own = ownShare('codex_local', { inputTokens: 155_225, cachedInputTokens: 3_318_784, outputTokens: 56_665, costUsd: null }, { inputTokens: 85_997, cachedInputTokens: 1_506_432, outputTokens: 21_354 })
  assert.deepEqual([own.inputTokens, own.cachedInputTokens, own.outputTokens], [69_228, 1_812_352, 35_311])
  assert.deepEqual(own.reported, { inputTokens: 155_225, cachedInputTokens: 3_318_784, outputTokens: 56_665 })
})

test('a fresh session, a number that fell, or a tool with per-run numbers is kept as it is', () => {
  assert.equal(ownShare('claude_local', { costUsd: 2.5 }, null).costUsd, 2.5)
  assert.equal(ownShare('claude_local', { costUsd: 0.4 }, { costUsd: 9 }).costUsd, 0.4)
  assert.equal(ownShare('claude_local', { costUsd: null }, { costUsd: 9 }).costUsd, null)
  const free = ownShare('opencode_local', { inputTokens: 10, outputTokens: 5 }, { inputTokens: 4, outputTokens: 2 })
  assert.deepEqual([free.inputTokens, free.outputTokens, free.reported], [10, 5, undefined])
})

test('the tool is told from the model for runs booked before', () => {
  assert.equal(adapterOfModel('claude-sonnet-5-5'), 'claude_local')
  assert.equal(adapterOfModel('gpt-5.5-codex'), 'codex_local')
  assert.equal(adapterOfModel('gemini-3.8-flash'), '')
  assert.equal(adapterOfModel('kilo/some-free-model'), '')
})

const run = (id, createdAt, before, after, usageJson) => ({ id, companyId: CO, agentId: BOT, issueId: 'job-1', status: 'succeeded', createdAt, updatedAt: createdAt, sessionIdBefore: before, sessionIdAfter: after, usageJson })

test('runs booked before are turned into their own share once, with their usage rows and list rows', () => {
  const store = openStore(':memory:')
  store.put('runs', run('r1', '2026-11-18T00:00:00.000Z', null, 's1', { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 10, costUsd: 94.07 }))
  store.put('runs', run('r2', '2026-11-18T00:05:00.000Z', 's1', 's1', { model: 'claude-sonnet-5-5', inputTokens: 40, outputTokens: 4, costUsd: 94.25 }), { summary_raw: { id: 'r2', inputTokens: '40' } })
  store.put('runs', run('r3', '2026-11-18T00:10:00.000Z', 's1', 's1', { model: 'claude-sonnet-5-5', inputTokens: 70, outputTokens: 7, costUsd: 94.45 }))
  store.put('runs', run('c1', '2026-11-18T01:00:00.000Z', null, 't1', { model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 5000, outputTokens: 100 }))
  store.put('runs', run('c2', '2026-11-18T01:30:00.000Z', 't1', 't1', { model: 'gpt-5.5', inputTokens: 1500, cachedInputTokens: 9000, outputTokens: 160 }))
  store.put('usage', { id: 'u-c2', companyId: CO, heartbeatRunId: 'c2', agentId: BOT, inputTokens: 1500, cachedInputTokens: 9000, outputTokens: 160, occurredAt: '2026-11-18T01:30:00.000Z' })

  assert.equal(convertBookedRuns(store), 5)
  const usageOf = (id) => store.object('SELECT raw FROM runs WHERE id = ?', id).usageJson
  assert.equal(usageOf('r1').costUsd, 94.07)
  assert.equal(usageOf('r2').costUsd, 0.18)
  assert.equal(usageOf('r3').costUsd, 0.2)
  assert.equal(usageOf('r3').inputTokens, 70)
  assert.deepEqual([usageOf('c2').inputTokens, usageOf('c2').cachedInputTokens, usageOf('c2').outputTokens], [500, 4000, 60])
  assert.equal(JSON.parse(store.row('SELECT usage_json FROM runs WHERE id = ?', 'c2').usage_json).inputTokens, 500)
  assert.deepEqual({ ...store.row('SELECT input_tokens i, cached_input_tokens c, output_tokens o FROM usage WHERE id = ?', 'u-c2') }, { i: 500, c: 4000, o: 60 })
  assert.equal(JSON.parse(store.row('SELECT summary_raw FROM runs WHERE id = ?', 'r2').summary_raw).inputTokens, '40')
  // Done once: a second start changes nothing, and the next run of the session reads the printed total.
  assert.equal(convertBookedRuns(store), 0)
  assert.equal(usageOf('r3').costUsd, 0.2)
  assert.equal(lastPrinted(store, BOT, 's1', '2026-11-18T02:00:00.000Z').costUsd, 94.45)
  assert.equal(lastPrinted(store, BOT, 't1', '2026-11-18T02:00:00.000Z').inputTokens, 1500)
})

test('a finished Claude run that resumed a session is booked with what it added', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botyard-usage-'))
  const store = openStore(':memory:')
  store.put('agents', { id: BOT, companyId: CO, name: 'Builder', adapterType: 'claude_local', createdAt: '2026-11-18T00:00:00.000Z' })
  store.put('runs', run('r1', '2026-11-18T00:00:00.000Z', null, 's1', { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 10, costUsd: 3.5, perRun: true, reported: { costUsd: 3.5 } }))
  fs.mkdirSync(runLogsDir(dataDir), { recursive: true })
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1', usage: { input_tokens: 60, output_tokens: 6 }, total_cost_usd: 4.25 }
  fs.writeFileSync(path.join(runLogsDir(dataDir), 'r2.ndjson'), `${JSON.stringify({ stream: 'stdout', chunk: `${JSON.stringify(result)}\n` })}\n`)
  const made = { ...run('r2', '2026-11-18T00:05:00.000Z', 's1', null, null), status: 'running', logRef: 'r2.ndjson', contextSnapshot: {} }
  store.put('runs', made)
  finishRun(store, made, { exitCode: 0 }, { dataDir })
  const usage = store.object('SELECT raw FROM runs WHERE id = ?', 'r2').usageJson
  assert.equal(usage.costUsd, 0.75)
  assert.equal(usage.inputTokens, 60)
  assert.deepEqual(usage.reported, { costUsd: 4.25 })
  fs.rmSync(dataDir, { recursive: true, force: true })
})
