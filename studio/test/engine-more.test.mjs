/** The rest of what the map reads from the engine: what needs a look, the feed, who made what, a bot's rules. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answer } from '../server/engine/api.mjs'
import { openStore } from '../server/engine/store.mjs'
import { MORE_PATHS } from '../server/engine/read-more.mjs'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

function studio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-more-'))
  const rules = path.join(dir, 'lead.md')
  fs.writeFileSync(rules, 'You are Lead.\n')
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for reading')
  const store = openStore(':memory:')
  store.put('company', { id: 'co', name: 'Lighthouse Works', issuePrefix: 'LH', issueCounter: 5, createdAt: ago(9999) })
  store.put('agents', { id: 'lead', companyId: 'co', name: 'Lead', role: 'ceo', status: 'idle', adapterType: 'claude_local', adapterConfig: { instructionsFilePath: rules }, createdAt: ago(900) })
  store.put('agents', { id: 'builder', companyId: 'co', name: 'Builder', role: 'engineer', status: 'idle', reportsTo: 'lead', adapterType: 'claude_local', adapterConfig: {}, createdAt: ago(800) })
  store.put('projects', { id: 'p1', companyId: 'co', name: 'Lighthouse' }, { position: 0 })
  const job = (id, n, extra = {}) => store.put('jobs', { id, companyId: 'co', identifier: `LH-${n}`, title: `Job ${n}`, status: 'in_progress', projectId: 'p1', assigneeAgentId: 'builder', createdByUserId: 'local-board', createdAt: ago(120), updatedAt: ago(10), ...extra })
  job('j1', 1)
  job('j2', 2, { parentId: 'j1' })
  job('j3', 3, { status: 'done', completedAt: ago(30) })
  const run = (id, jobId, status, minutes, usage = {}) => store.put('runs', { id, companyId: 'co', agentId: 'builder', issueId: jobId, status, error: status === 'failed' ? 'Adapter failed' : null, startedAt: ago(minutes), finishedAt: ago(minutes - 5), usageJson: usage, createdAt: ago(minutes), updatedAt: ago(minutes - 5) })
  run('r-old-fail', 'j1', 'failed', 90, { inputTokens: 100, outputTokens: 10 })
  run('r-new-ok', 'j1', 'succeeded', 60, { inputTokens: 200, cachedInputTokens: 5000, outputTokens: 20 })
  run('r-fail', 'j2', 'failed', 40, { inputTokens: 7, outputTokens: 3 })
  run('r-done-fail', 'j3', 'failed', 35)
  store.put('cards', { id: 'c1', companyId: 'co', issueId: 'j1', kind: 'ask_user_questions', status: 'pending', title: 'Which size ships?', createdAt: ago(20) }, { position: 0 })
  store.put('comments', { id: 'm1', issueId: 'j1', authorAgentId: 'builder', body: 'Report', createdAt: ago(15) }, { position: 0 })
  store.put('attachments', { id: 'a1', companyId: 'co', issueId: 'j1', contentType: 'image/png', originalFilename: 'shot.png', createdByAgentId: 'builder', createdAt: ago(14), updatedAt: ago(14) }, { position: 0 })
  store.put('usage', { id: 'u1', companyId: 'co', heartbeatRunId: 'r-new-ok', agentId: 'builder', provider: 'anthropic', biller: 'anthropic', inputTokens: 200, cachedInputTokens: 5000, outputTokens: 20, occurredAt: ago(55) })
  store.put('usage', { id: 'u2', companyId: 'co', heartbeatRunId: 'r-x', agentId: 'builder', provider: 'anthropic', biller: 'anthropic', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, occurredAt: ago(60 * 30) })
  return { store, get: (url) => answer(store, { url }, { dataDir: dir, now: NOW }) }
}

test('what needs a look is the owner\'s waiting cards and the runs that failed last on a job still open', () => {
  const { get } = studio()
  const items = get('/api/companies/co/attention').body.items
  assert.deepEqual(items.map((i) => [i.sourceKind, i.subject.metadata.issueId]), [['issue_thread_interaction', 'j1'], ['failed_run', 'j2']],
    'j1 failed once but ran clean after; j3 failed but is done: neither is news')
  assert.equal(get('/api/companies/co/sidebar-badges').body.failedRuns, 1)
  assert.deepEqual(get('/api/companies/co/approvals?status=pending').body, [])
})

test('the feed, the org chart, the tokens by window, a job\'s cost and what the crew made are read from the store', () => {
  const { get } = studio()
  const feed = get('/api/companies/co/timeline').body
  assert.ok(feed.events.some((e) => e.kind === 'commented' && e.actorId === 'agent:builder' && e.issueId === 'j1'))
  assert.ok(feed.edges.some((e) => e.fromActorId === 'user:local-board' && e.toActorId === 'agent:builder'))
  assert.equal(feed.spans.find((sp) => sp.runId === 'r-fail').status, 'failed')
  assert.deepEqual(get('/api/companies/co/org').body, [{ id: 'lead', name: 'Lead', role: 'ceo', status: 'idle', reports: [{ id: 'builder', name: 'Builder', role: 'engineer', status: 'idle', reports: [] }] }])
  const spend = get('/api/companies/co/costs/window-spend').body
  assert.equal(spend.find((w) => w.window === '5h').inputTokens, 200)
  assert.equal(spend.find((w) => w.window === '7d').inputTokens, 1200)
  const cost = get('/api/issues/LH-1/cost-summary').body
  assert.deepEqual([cost.issueCount, cost.runCount, cost.inputTokens, cost.cachedInputTokens, cost.outputTokens], [2, 3, 307, 5000, 33], 'the job and the one under it')
  const made = get('/api/companies/co/artifacts?kind=image').body.artifacts
  assert.equal(made[0].title, 'shot.png')
  assert.equal(made[0].issue.identifier, 'LH-1')
  assert.equal(made[0].project.name, 'Lighthouse')
  assert.equal(made[0].createdByAgent.name, 'Builder')
  assert.deepEqual(get('/api/companies/co/artifacts?kind=video').body.artifacts, [])
  assert.equal(get('/api/companies/co/members').body.members[0].membershipRole, 'owner')
  assert.equal(get('/api/companies/nope/dashboard').status, 404)
})

test('a bot\'s rules are read from its own file in the crew\'s folder, and no other file is', () => {
  const { get } = studio()
  const bundle = get('/api/agents/lead/instructions-bundle').body
  assert.equal(bundle.mode, 'managed')
  assert.equal(bundle.entryFile, 'lead.md')
  assert.equal(get('/api/agents/lead/instructions-bundle/file?path=lead.md').body.content, 'You are Lead.\n')
  assert.equal(get('/api/agents/lead/instructions-bundle/file?path=secret.txt').status, 404)
  assert.equal(get('/api/agents/lead/instructions-bundle/file?path=../lead.md').body.content, 'You are Lead.\n', 'only the name counts: it is the bot\'s own file either way')
  // A bot with no file of its own gets one the engine keeps for it, empty until its instructions are saved.
  assert.equal(get('/api/agents/builder/instructions-bundle').body.entryFile, 'builder.md')
  assert.equal(get('/api/agents/builder/instructions-bundle/file').body.content, '')
  assert.ok(MORE_PATHS.includes('/companies/:id/attention'))
})

test('jobs are found by words in the code, the title, the brief or what was said, the title first; a goal is saved on its project', () => {
  const { store, get } = studio()
  store.put('comments', { id: 'm2', issueId: 'j2', authorAgentId: 'builder', body: 'The cistern leaks at the seam.', createdAt: ago(5) }, { position: 0 })
  store.put('jobs', { ...store.object("SELECT raw FROM jobs WHERE id = 'j3'"), title: 'Cistern looks hand-built' })
  const found = get('/api/companies/co/search?q=cistern&scope=issues').body.results
  assert.deepEqual(found.map((r) => r.issue.id), ['j3', 'j2'])
  assert.match(found[1].snippet, /cistern leaks/)
  assert.equal(get('/api/companies/co/search?q=cistern%20seam').body.results.length, 1)
  assert.equal(get('/api/companies/co/search?q=LH-1').body.results[0].issue.id, 'j1')
  assert.equal(get('/api/companies/co/search?q=nothinglikethis').body.zeroResults, true)
  const patch = (body) => answer(store, { method: 'PATCH', url: '/api/projects/p1', body }, { now: NOW })
  assert.equal(patch({ description: 'GOAL: Part One to outside players' }).body.description, 'GOAL: Part One to outside players')
  assert.equal(store.object("SELECT raw FROM projects WHERE id = 'p1'").description, 'GOAL: Part One to outside players')
})
