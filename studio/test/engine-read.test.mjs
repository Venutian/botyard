/**
 * The engine's answers, from rows put in a store by hand: each read path gives the object it was
 * given, in the API's order, with its filters, and refuses in its words.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../server/engine/store.mjs'
import * as read from '../server/engine/read.mjs'
import { READ_PATHS, handle, listen } from '../server/engine/http.mjs'

const CO = 'a0000000-0000-4000-8000-000000000001'
const LEAD = '11111111-1111-4111-8111-111111111111'
const FREE = '22222222-2222-4222-8222-222222222222'
const JOB = '55555555-5555-4555-8555-555555555555'
const CHILD = '56555555-5555-4555-8555-555555555555'
const CHAT = '57555555-5555-4555-8555-555555555555'
const PLAN = '58555555-5555-4555-8555-555555555555'
const HIDDEN = '59555555-5555-4555-8555-555555555555'
const LIGHTHOUSE = '88888888-8888-4888-8888-888888888888'
const HARBOUR = '89888888-8888-4888-8888-888888888888'
const FOLDER = '8a888888-8888-4888-8888-888888888888'
const ROUTINE = '99999999-9999-4999-8999-999999999999'
const RUN = '66666666-6666-4666-8666-666666666666'
const RUN2 = '67666666-6666-4666-8666-666666666666'
const LIVE = '68666666-6666-4666-8666-666666666666'
const DOC = '77777777-7777-4777-8777-777777777777'
const NOBODY = '00000000-0000-4000-8000-000000000000'

const page = (id, n, title, extra = {}) => ({
  id, companyId: CO, identifier: `LH-${n}`, issueNumber: n, title, description: `About ${title}`, status: 'todo', priority: 'medium', projectId: LIGHTHOUSE, parentId: null,
  assigneeAgentId: FREE, conversationAgentId: null, conversationUserId: null, hiddenAt: null, harnessKind: null, originKind: 'manual', labels: [], labelIds: [],
  blockerAttention: { state: 'none' }, reviewAttention: { state: 'none' }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  ancestors: [], blockedBy: [], blocks: [], project: { id: LIGHTHOUSE, name: 'Lighthouse' }, workProducts: [], ...extra,
})
/** The list's row of a job: its page without the page-only parts, with the last-activity time. */
const row = (p, lastActivityAt = p.updatedAt) => {
  const { ancestors, blockedBy, blocks, project, workProducts, ...rest } = p
  return { ...rest, descriptionTruncated: false, activeRun: null, lastActivityAt }
}

function filled() {
  const store = openStore(':memory:')
  store.put('company', { id: CO, name: 'The Yard', description: 'The studio', status: 'active', issuePrefix: 'LH', issueCounter: 9 })
  store.put('agents', { id: LEAD, companyId: CO, name: 'Lead', role: 'ceo', status: 'idle', urlKey: 'lead', appearance: { paletteId: 'gold' }, avatarUrl: '/avatars/lead', createdAt: '2026-10-01T00:00:00.000Z', chainOfCommand: [], access: { canAssignTasks: true } })
  store.put('agents', { id: FREE, companyId: CO, name: 'Freelancer', role: 'engineer', status: 'running', urlKey: 'free', appearance: { paletteId: 'green' }, avatarUrl: '/avatars/free', createdAt: '2026-10-02T00:00:00.000Z', chainOfCommand: [{ id: LEAD }], access: {} })
  store.replace('sessions', 'agent_id', FREE, [{ id: 's2', agentId: FREE, taskKey: JOB, sessionParamsJson: { cwd: '/work/LH-7' } }, { id: 's1', agentId: FREE, taskKey: CHILD }])
  store.replace('agent_revisions', 'agent_id', FREE, [{ id: 'v2', agentId: FREE, changedKeys: ['model'] }, { id: 'v1', agentId: FREE, changedKeys: ['name'] }])
  store.put('projects', { id: LIGHTHOUSE, companyId: CO, name: 'Lighthouse', urlKey: 'lighthouse', description: 'Goal: ship', workspaces: [], taskCount: 4, budget: null }, { position: 0 })
  store.put('projects', { id: HARBOUR, companyId: CO, name: 'Harbour', urlKey: 'harbour', workspaces: [], taskCount: 1, budget: null }, { position: 1 })

  const jobs = [
    [page(JOB, 7, 'Fix the map', { status: 'in_progress', priority: 'high', description: 'The map is slow', executionWorkspaceId: FOLDER, updatedAt: '2026-11-11T10:00:00.000Z' }), '2026-11-11T12:00:00.000Z'],
    [page(CHILD, 8, 'Check LH-7: Fix the map', { status: 'done', priority: 'high', parentId: JOB, assigneeAgentId: LEAD, updatedAt: '2026-11-11T11:00:00.000Z' }), '2026-11-11T11:00:00.000Z'],
    [page(PLAN, 9, 'Plan: Harbour next', { status: 'done', priority: 'critical', projectId: HARBOUR, assigneeAgentId: null, description: 'x'.repeat(1500) }), '2026-11-10T00:00:00.000Z'],
    [page(HIDDEN, 10, 'A hidden job', { hiddenAt: '2026-11-05T00:00:00.000Z' }), '2026-11-10T00:00:00.000Z'],
  ]
  for (const [p, lastActivityAt] of jobs) store.put('jobs', p, { list_raw: { ...row(p, lastActivityAt), description: p.description.slice(0, 1200), descriptionTruncated: p.description.length > 1200 } })
  // A chat is a job with a bot on the other end. The job list never showed it, so it has no list row.
  store.put('jobs', page(CHAT, 2, 'Chat with Lead', { status: 'in_progress', projectId: null, assigneeAgentId: LEAD, conversationAgentId: LEAD, conversationUserId: 'local-board', conversationState: 'active', description: 'the map again', updatedAt: '2026-11-12T00:00:00.000Z' }))

  store.replace('comments', 'job_id', JOB, [{ id: 'c3', issueId: JOB, body: 'Third: the frame budget is met' }, { id: 'c2', issueId: JOB, body: 'Second' }, { id: 'c1', issueId: JOB, body: 'First' }])
  store.replace('cards', 'job_id', JOB, [{ id: 'card1', issueId: JOB, kind: 'ask_user_questions', status: 'pending' }, { id: 'card2', issueId: JOB, kind: 'request_confirmation', status: 'accepted' }])
  store.put('documents', { id: DOC, issueId: JOB, key: 'plan', title: 'Plan', format: 'markdown', body: '# Plan v2 with a turbine', latestRevisionNumber: 2 })
  store.put('documents', { id: 'summary-doc', issueId: JOB, key: 'continuation-summary', title: 'Where the bot left off', body: 'Next: measure the gearbox' })
  store.put('job_documents', null, { job_id: JOB, key: 'continuation-summary', document_id: 'summary-doc', position: 0 })
  store.put('job_documents', null, { job_id: JOB, key: 'plan', document_id: DOC, position: 1 })
  store.replace('document_versions', 'document_id', DOC, [{ id: 'r2', documentId: DOC, revisionNumber: 2, body: '# Plan v2' }, { id: 'r1', documentId: DOC, revisionNumber: 1, body: '# Plan' }])
  store.replace('attachments', 'job_id', JOB, [{ id: 'file1', issueId: JOB, originalFilename: 'shot.png', contentType: 'image/png', byteSize: 5 }])
  store.replace('job_runs', 'job_id', JOB, [{ runId: RUN2, status: 'failed' }, { runId: RUN, status: 'succeeded' }], () => ({ job_id: JOB }))

  const runPage = (id, agentId, status, createdAt, extra = {}) => ({ id, companyId: CO, agentId, issueId: JOB, status, createdAt, updatedAt: createdAt, usageJson: { inputTokens: 10 }, sessionIdBefore: null, sessionIdAfter: 'abc', logStore: 'local_file', logRef: `${id}.ndjson`, logSha256: 'sha', externalRunId: null, processPid: 42, processGroupId: 42, resultJson: { summary: `${'word '.repeat(150)}end`, total_cost_usd: 0.5, session_id: 'not listed' }, contextSnapshot: { issueId: JOB, taskMarkdown: 'long' }, ...extra })
  const shortOf = (p) => ({ id: p.id, companyId: CO, agentId: p.agentId, issueId: JOB, status: p.status, createdAt: p.createdAt, inputTokens: '10', usageJson: null, sessionIdBefore: null, sessionIdAfter: null, logStore: null, logRef: null, logSha256: null, externalRunId: null, processPid: null, processGroupId: null, resultJson: null, contextSnapshot: { issueId: JOB } })
  for (const p of [runPage(RUN, FREE, 'succeeded', '2026-11-11T10:00:00.000Z'), runPage(RUN2, LEAD, 'failed', '2026-11-11T11:00:00.000Z', { resultJson: null })]) store.put('runs', p, { summary_raw: shortOf(p) })
  const going = runPage(LIVE, FREE, 'running', '2026-11-11T12:00:00.000Z')
  store.put('runs', going, { summary_raw: shortOf(going), live_raw: { id: LIVE, companyId: CO, status: 'running', agentId: FREE, agentName: 'Freelancer', scopeKind: 'issue', issueId: JOB, inputTokens: '10', cachedInputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, outputSilence: { level: 'none' } } })

  store.put('routines', { id: ROUTINE, companyId: CO, title: 'Nightly', status: 'active', triggers: [{ id: 't1', cronExpression: '0 3 * * *' }], recentRuns: [], assignee: { id: LEAD } }, { position: 0, list_raw: { id: ROUTINE, companyId: CO, title: 'Nightly', status: 'active', triggers: [{ id: 't1' }], lastRun: null } })
  store.replace('routine_runs', 'routine_id', ROUTINE, [{ id: 'rr2', routineId: ROUTINE, status: 'failed' }, { id: 'rr1', routineId: ROUTINE, status: 'completed' }])
  store.replace('routine_revisions', 'routine_id', ROUTINE, [{ id: 'rv1', routineId: ROUTINE, revisionNumber: 1 }])
  store.put('workspaces', { id: FOLDER, companyId: CO, projectId: LIGHTHOUSE, sourceIssueId: JOB, cwd: '/work/LH-7', branchName: 'LH-7-fix-the-map', deliveryState: 'unmerged' })

  const usage = (id, extra) => store.put('usage', { id, company_id: CO, agent_id: FREE, project_id: LIGHTHOUSE, heartbeat_run_id: RUN, provider: 'anthropic', biller: 'anthropic', billing_type: 'subscription_included', model: 'sonnet', cost_status: 'unpriced', receipt_hash: 'h', input_tokens: 100, cached_input_tokens: 900, output_tokens: 50, cost_cents_text: '0.0000000', occurred_at: '2026-11-11T10:00:00+00:00', ...extra })
  usage('u1', {})
  usage('u2', { heartbeat_run_id: RUN2, agent_id: LEAD, model: 'opus', input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, cost_cents_text: '1.2500000', billing_type: 'metered_api', cost_status: 'estimated' })
  // An old row: no receipt, no project, cached tokens counted inside the input. Its run touched one project.
  usage('u3', { heartbeat_run_id: LIVE, provider: 'openai', biller: 'openai', model: 'gpt', receipt_hash: null, project_id: null, billing_type: 'subscription_overage', input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10, cost_cents_text: '0.1000000', occurred_at: '2026-10-20T00:00:00+00:00' })
  store.put('activity', { id: 'act1', company_id: CO, action: 'issue.updated', entity_type: 'issue', entity_id: PLAN, run_id: LIVE, created_at: '2026-10-20T00:00:00+00:00' })
  return store
}
const get = (store, where, now) => handle(store, 'GET', where, now ? { now } : undefined)
const ids = (list) => list.map((item) => item.id)

test('the company, its bots and its projects come back as they were given', () => {
  const store = filled()
  assert.deepEqual(ids(read.companies(store)), [CO])
  assert.equal(read.company(store, CO).issuePrefix, 'LH')
  assert.throws(() => read.company(store, NOBODY), { status: 404, message: 'Company not found' })
  // The bot list leaves out what only a bot's own page says.
  const bots = read.agents(store, CO)
  assert.deepEqual(bots.map((b) => b.name), ['Lead', 'Freelancer'])
  assert.equal('chainOfCommand' in bots[0], false)
  assert.equal('access' in bots[0], false)
  assert.deepEqual(read.agent(store, FREE).chainOfCommand, [{ id: LEAD }])
  assert.equal(read.agent(store, 'lead').id, LEAD)
  assert.throws(() => read.agent(store, NOBODY), { status: 404, message: 'Agent not found' })
  assert.deepEqual(ids(read.taskSessions(store, FREE)), ['s2', 's1'])
  assert.deepEqual(ids(read.configRevisions(store, FREE)), ['v2', 'v1'])
  assert.deepEqual(read.taskSessions(store, LEAD), [])
  // The project list counts jobs; a project's own page does not.
  assert.deepEqual(read.projects(store, CO).map((p) => [p.name, p.taskCount]), [['Lighthouse', 4], ['Harbour', 1]])
  assert.equal('taskCount' in read.project(store, LIGHTHOUSE), false)
  assert.equal(read.project(store, LIGHTHOUSE).description, 'Goal: ship')
  assert.throws(() => read.project(store, NOBODY), { status: 404, message: 'Project not found' })
  store.close()
})

test('the job list leaves out chats and hidden jobs, and orders by priority, then by what moved last', () => {
  const store = filled()
  const all = read.jobs(store, CO, { limit: '100000' })
  assert.deepEqual(all.map((j) => j.identifier), ['LH-9', 'LH-7', 'LH-8'])
  assert.equal(all[1].lastActivityAt, '2026-11-11T12:00:00.000Z')
  assert.equal('ancestors' in all[1], false, 'a list row is not the whole page')
  assert.equal(all[0].description.length, 1200)
  assert.equal(all[0].descriptionTruncated, true)
  assert.deepEqual(read.jobs(store, NOBODY), [])
  store.close()
})

test('the job list filters by state, project, bot and parent, a page at a time', () => {
  const store = filled()
  const codes = (query) => read.jobs(store, CO, query).map((j) => j.identifier)
  assert.deepEqual(codes({ status: 'done' }), ['LH-9', 'LH-8'])
  assert.deepEqual(codes({ status: 'in_progress, todo ,blocked' }), ['LH-7'])
  assert.deepEqual(codes({ status: 'nope' }), [])
  assert.deepEqual(codes({ projectId: HARBOUR }), ['LH-9'])
  assert.deepEqual(codes({ assigneeAgentId: LEAD }), ['LH-8'])
  assert.deepEqual(codes({ assigneeAgentId: 'null' }), ['LH-9'])
  assert.deepEqual(codes({ parentId: JOB }), ['LH-8'])
  assert.deepEqual(codes({ limit: '1' }), ['LH-9'])
  assert.deepEqual(codes({ limit: '1', offset: '1' }), ['LH-7'])
  assert.deepEqual(codes({ projectId: LIGHTHOUSE, status: 'done', limit: '5', view: 'compact' }), ['LH-8'])
  assert.throws(() => read.jobs(store, CO, { limit: '0' }), { status: 400, message: 'limit must be a positive integer up to 1000' })
  assert.throws(() => read.jobs(store, CO, { limit: 'many' }), { status: 400 })
  assert.throws(() => read.jobs(store, CO, { view: 'wide' }), { status: 400, message: "view must be 'compact' when provided" })
  assert.throws(() => read.jobs(store, CO, { assigneeAgentId: 'free' }), { status: 422 })
  store.close()
})

test('the compact view keeps the short set of fields and nothing else', () => {
  const store = filled()
  const [first] = read.jobs(store, CO, { view: 'compact', status: 'in_progress' })
  assert.equal(first.identifier, 'LH-7')
  assert.equal(first.lastActivityAt, '2026-11-11T12:00:00.000Z')
  assert.deepEqual(first.blockerAttention, { state: 'none' })
  assert.equal(first.activeRecoveryAction, null)
  assert.equal(first.successfulRunHandoff, null)
  assert.equal(first.externalConversationState, null)
  for (const gone of ['descriptionTruncated', 'activeRun', 'conversationAgentId', 'hiddenAt', 'responsibleUserId']) assert.equal(gone in first, false, `${gone} is not in the compact view`)
  store.close()
})

test('a search finds words in titles, descriptions, comments and documents, best match first, chats included', () => {
  const store = filled()
  const codes = (q, extra = {}) => read.jobs(store, CO, { q, ...extra }).map((j) => j.identifier)
  // Both words in the title beats the words spread over a description; an open job beats a done one.
  assert.deepEqual(codes('fix map'), ['LH-7', 'LH-8'])
  assert.deepEqual(codes('the map'), ['LH-7', 'LH-8', 'LH-2'], '"the" is filler; the chat matches by its description')
  assert.deepEqual(codes('Plan:'), ['LH-9'])
  assert.deepEqual(codes('plan'), ['LH-9', 'LH-7'], 'the second by its document')
  assert.deepEqual(codes('frame budget'), ['LH-7'], 'found in a comment')
  assert.deepEqual(codes('turbine'), ['LH-7'], 'found in a document')
  assert.deepEqual(codes('lh-8'), ['LH-8'], 'a typed job code is that job')
  assert.deepEqual(codes('LH 8'), ['LH-8'])
  assert.deepEqual(codes('map', { status: 'done' }), ['LH-8'])
  assert.deepEqual(codes('map', { projectId: HARBOUR }), [])
  assert.deepEqual(codes('hidden'), [], 'a hidden job is never found')
  // A short word has to start a word, and a near miss in spelling finds the title when nothing else does.
  assert.deepEqual(codes('ap'), [])
  assert.deepEqual(codes('harbourr'), ['LH-9'])
  assert.deepEqual(codes('"harbourr"'), [], 'quoted words are taken as typed')
  // A chat found by a search has no list row of its own, so one is made from its page.
  const chat = read.jobs(store, CO, { q: 'chat lead' })[0]
  assert.equal(chat.identifier, 'LH-2')
  assert.equal(chat.descriptionTruncated, false)
  assert.equal(chat.activeRun, null)
  assert.equal('ancestors' in chat, false)
  assert.deepEqual(read.searchWords('  The  "Fix Map" of the LH-7 ').tokens, ['fix map', 'lh-7'])
  store.close()
})

test('a job is found by its id or its code, with everything under it in order', () => {
  const store = filled()
  assert.equal(read.job(store, JOB).description, 'The map is slow')
  assert.deepEqual(read.job(store, 'lh-7'), read.job(store, JOB))
  assert.deepEqual(read.job(store, JOB).ancestors, [])
  for (const ref of [NOBODY, 'LH-999', 'not a job', '']) assert.throws(() => read.job(store, ref), { status: 404, message: 'Issue not found' })
  assert.deepEqual(ids(read.comments(store, JOB)), ['c3', 'c2', 'c1'])
  assert.deepEqual(ids(read.comments(store, 'LH-7', { limit: '2' })), ['c3', 'c2'])
  assert.deepEqual(ids(read.comments(store, JOB, { limit: '2', order: 'asc' })), ['c1', 'c2'])
  assert.deepEqual(read.comments(store, CHILD), [])
  assert.throws(() => read.comments(store, NOBODY), { status: 404, message: 'Issue not found' })
  assert.deepEqual(ids(read.cards(store, JOB)), ['card1', 'card2'])
  // The summary an engine writes for itself is not listed unless asked for, but is read by name and searched.
  assert.deepEqual(read.documents(store, JOB).map((d) => d.key), ['plan'])
  assert.deepEqual(read.documents(store, JOB, { includeSystem: 'true' }).map((d) => d.key), ['continuation-summary', 'plan'])
  assert.equal(read.document(store, JOB, 'continuation-summary').title, 'Where the bot left off')
  assert.deepEqual(read.jobs(store, CO, { q: 'gearbox' }).map((j) => j.identifier), ['LH-7'])
  assert.equal(read.document(store, JOB, 'plan').body, '# Plan v2 with a turbine')
  assert.throws(() => read.document(store, JOB, 'nope'), { status: 404, message: 'Document not found' })
  assert.deepEqual(read.documentRevisions(store, JOB, 'plan').map((r) => r.revisionNumber), [2, 1])
  assert.deepEqual(read.attachments(store, JOB).map((a) => a.originalFilename), ['shot.png'])
  assert.deepEqual(read.jobRuns(store, JOB).map((r) => r.runId), [RUN2, RUN])
  assert.equal(read.workspace(store, FOLDER).deliveryState, 'unmerged')
  assert.throws(() => read.workspace(store, NOBODY), { status: 404, message: 'Execution workspace not found' })
  store.close()
})

test('a job page speaks of other things as they are now, not as they were when the page was kept', () => {
  const store = filled()
  const kept = page(CHILD, 8, 'Check LH-7: Fix the map', {
    status: 'done', parentId: JOB,
    ancestors: [{ id: JOB, identifier: 'LH-7', title: 'Fix the map', description: 'The map is slow', status: 'todo', priority: 'low', project: { id: LIGHTHOUSE, name: 'As kept' } }],
    blockedBy: [{ id: PLAN, identifier: 'LH-9', title: 'An older title', status: 'todo', priority: 'critical', assigneeAgentId: null, scheduledRetry: null }],
    blocks: [{ id: NOBODY, identifier: 'LH-404', title: 'A job the store does not have', status: 'todo' }],
    relatedWork: { inbound: [{ issue: { id: JOB, identifier: 'LH-7', title: 'Fix the map', status: 'backlog' }, mentionCount: 2, sources: ['comment'] }], outbound: [] },
    project: { id: LIGHTHOUSE, name: 'Lighthouse before it was renamed', description: 'Goal: ship', workspaces: [{ id: 'kept as it was' }] },
    currentExecutionWorkspace: { id: FOLDER, cwd: '/work/LH-7', deliveryState: 'unknown', metadata: { kept: true } },
  })
  store.put('jobs', kept, { list_raw: row(kept) })
  const now = read.job(store, CHILD)
  assert.equal(now.ancestors[0].status, 'in_progress')
  assert.equal(now.ancestors[0].priority, 'high')
  assert.deepEqual(now.ancestors[0].project, { id: LIGHTHOUSE, name: 'As kept' }, 'only the plain fields are brought up to date')
  assert.equal(now.blockedBy[0].status, 'done')
  assert.equal(now.blockedBy[0].title, 'Plan: Harbour next')
  assert.equal(now.blockedBy[0].scheduledRetry, null)
  assert.deepEqual(now.blocks, kept.blocks, 'a job the store does not have stays as the page said')
  assert.equal(now.relatedWork.inbound[0].issue.status, 'in_progress')
  assert.equal(now.relatedWork.inbound[0].mentionCount, 2)
  assert.equal(now.project.name, 'Lighthouse')
  assert.deepEqual(now.project.workspaces, [{ id: 'kept as it was' }])
  assert.equal(now.currentExecutionWorkspace.deliveryState, 'unmerged')
  assert.deepEqual(now.currentExecutionWorkspace.metadata, { kept: true })
  assert.equal(store.object('SELECT raw FROM jobs WHERE id = ?', CHILD).blockedBy[0].status, 'todo', 'reading changes nothing in the store')
  store.close()
})

test('chats are the bare job, the one last touched first, and a bot without a chat gives null', () => {
  const store = filled()
  const [chat] = read.chats(store, CO)
  assert.equal(chat.id, CHAT)
  assert.equal(chat.conversationAgentId, LEAD)
  for (const gone of ['ancestors', 'blockedBy', 'project', 'labels', 'blockerAttention', 'workProducts']) assert.equal(gone in chat, false, `${gone} is not part of a chat`)
  assert.deepEqual(read.chat(store, CO, LEAD), chat)
  assert.deepEqual(read.chat(store, CO, 'lead'), chat)
  assert.equal(read.chat(store, CO, FREE), null)
  assert.throws(() => read.chat(store, CO, NOBODY), { status: 404, message: 'Agent not found' })
  store.close()
})

test('runs are listed newest first, short or full, for everyone or one bot', () => {
  const store = filled()
  const short = read.runs(store, CO, { summary: 'true', limit: '50' })
  assert.deepEqual(ids(short), [LIVE, RUN2, RUN])
  assert.equal(short[2].usageJson, null)
  assert.equal(short[2].inputTokens, '10')
  assert.deepEqual(ids(read.runs(store, CO, { summary: 'true', agentId: FREE })), [LIVE, RUN])
  assert.deepEqual(ids(read.runs(store, CO, { summary: '1', limit: '1' })), [LIVE])
  // The full list keeps the usage, the session and the log, and a cut of the result.
  const full = read.runs(store, CO, { limit: '5' })
  assert.deepEqual(full[2].usageJson, { inputTokens: 10 })
  assert.equal(full[2].sessionIdAfter, 'abc')
  assert.equal(full[2].logRef, `${RUN}.ndjson`)
  assert.equal(full[2].processPid, 42)
  assert.equal(full[2].resultJson.summary.length, 500)
  assert.equal(full[2].resultJson.total_cost_usd, 0.5)
  assert.equal('session_id' in full[2].resultJson, false)
  assert.equal(full[1].resultJson, null)
  assert.deepEqual(full[2].contextSnapshot, { issueId: JOB })
  // A run's own page is the whole thing.
  assert.equal(read.run(store, RUN).contextSnapshot.taskMarkdown, 'long')
  assert.throws(() => read.run(store, NOBODY), { status: 404, message: 'Heartbeat run not found' })
  assert.throws(() => read.run(store, 'nope'), { status: 400, message: 'Invalid heartbeat run ID' })
  store.close()
})

test('live runs are the ones still going, for the company and for one job', () => {
  const store = filled()
  const live = read.liveRuns(store, CO)
  assert.deepEqual(ids(live), [LIVE])
  assert.equal(live[0].agentName, 'Freelancer')
  const onJob = read.jobLiveRuns(store, JOB)
  assert.deepEqual(ids(onJob), [LIVE])
  for (const gone of ['companyId', 'issueId', 'inputTokens', 'costUsd']) assert.equal(gone in onJob[0], false)
  assert.deepEqual(onJob[0].outputSilence, { level: 'none' })
  assert.deepEqual(read.jobLiveRuns(store, CHILD), [])
  // Once the run is over it is not live, whatever was kept of it.
  store.db.exec(`UPDATE runs SET status = 'succeeded' WHERE id = '${LIVE}'`)
  assert.deepEqual(read.liveRuns(store, CO), [])
  store.close()
})

test('a run Botyard started itself is listed like any other, from its page alone', () => {
  const store = filled()
  const OWN = '69666666-6666-4666-8666-666666666666'
  store.put('runs', { id: OWN, companyId: CO, agentId: LEAD, scopeKind: 'issue', issueId: CHILD, status: 'running', invocationSource: 'assignment', createdAt: '2026-11-12T08:00:00.000Z', startedAt: '2026-11-12T08:00:01.000Z', usageJson: { inputTokens: 1200, outputTokens: 30 }, resultJson: { total_cost_usd: 0.25, summary: 'Half way' }, logRef: 'own.ndjson', sessionIdAfter: 'xyz', contextSnapshot: { issueId: CHILD, wakeReason: 'issue_assigned', taskMarkdown: 'long' } })
  const [short] = read.runs(store, CO, { summary: 'true', limit: '1' })
  assert.equal(short.id, OWN)
  assert.equal(short.inputTokens, '1200')
  assert.equal(short.outputTokens, '30')
  assert.equal(short.cachedInputTokens, null)
  assert.equal(short.costUsd, '0.25')
  assert.equal(short.usageJson, null)
  assert.equal(short.logRef, null)
  assert.equal(short.resultJson, null)
  assert.deepEqual(short.contextSnapshot, { issueId: CHILD, wakeReason: 'issue_assigned' })
  const [full] = read.runs(store, CO, { limit: '1' })
  assert.deepEqual(full.usageJson, { inputTokens: 1200, outputTokens: 30 })
  assert.equal(full.logRef, 'own.ndjson')
  assert.deepEqual(full.resultJson, { summary: 'Half way', total_cost_usd: 0.25 })
  // And it is live, with its bot's name and face, for the company and for its job.
  const live = read.liveRuns(store, CO)
  assert.deepEqual(ids(live), [OWN, LIVE])
  assert.equal(live[0].agentName, 'Lead')
  assert.equal(live[0].avatarUrl, '/avatars/lead')
  assert.equal(live[0].inputTokens, '1200')
  assert.deepEqual(ids(read.jobLiveRuns(store, CHILD)), [OWN])
  assert.equal('issueId' in read.jobLiveRuns(store, CHILD)[0], false)
  store.close()
})

test('routines come as the list gives them, and one routine with its runs and revisions', () => {
  const store = filled()
  const [listed] = read.routines(store, CO)
  assert.equal(listed.lastRun, null)
  assert.equal('recentRuns' in listed, false)
  assert.deepEqual(read.routine(store, ROUTINE).assignee, { id: LEAD })
  assert.deepEqual(ids(read.routineRuns(store, ROUTINE)), ['rr2', 'rr1'])
  assert.deepEqual(ids(read.routineRevisions(store, ROUTINE)), ['rv1'])
  for (const ask of [read.routine, read.routineRuns, read.routineRevisions]) assert.throws(() => ask(store, NOBODY), { status: 404, message: 'Routine not found' })
  store.close()
})

test('tokens and cost are summed by bot, model, provider and project, exactly', () => {
  const store = filled()
  const all = { period: 'all' }
  const byBot = read.costs(store, CO, 'by-agent', all)
  assert.deepEqual(byBot.map((r) => [r.agentName, r.eventCount, r.costCentsExact, r.costCents]), [['Lead', 1, '1.2500000', 1.25], ['Freelancer', 2, '0.1000000', 0.1]])
  const free = byBot[1]
  // The old row's cached tokens are taken out of its input: 100 + (1000 - 400).
  assert.equal(free.inputTokens, 700)
  assert.equal(free.cachedInputTokens, 1300)
  assert.equal(free.outputTokens, 60)
  assert.equal(free.subscriptionRunCount, 2)
  assert.equal(free.apiRunCount, 0)
  assert.equal(free.agentStatus, 'running')
  assert.deepEqual(free.agentAppearance, { paletteId: 'green' })
  assert.equal(free.avatarUrl, '/avatars/free')
  assert.equal(byBot[0].apiRunCount, 1)
  assert.equal(byBot[0].estimatedEventCount, 1)

  assert.deepEqual(read.costs(store, CO, 'by-agent-model', all).map((r) => [r.agentName, r.provider, r.model, r.eventCount]), [['Lead', 'anthropic', 'opus', 1], ['Freelancer', 'anthropic', 'sonnet', 1], ['Freelancer', 'openai', 'gpt', 1]])
  const providers = read.costs(store, CO, 'by-provider', all)
  assert.deepEqual(providers.map((r) => [r.model, r.costCentsExact, r.unpricedEventCount]), [['opus', '1.2500000', 0], ['gpt', '0.1000000', 1], ['sonnet', '0.0000000', 0]])
  // The old row names no project, but its run only ever touched Harbour.
  assert.deepEqual(read.costs(store, CO, 'by-project', all).map((r) => [r.projectName, r.eventCount, r.costCentsExact]), [['Lighthouse', 2, '1.2500000'], ['Harbour', 1, '0.1000000']])

  // A range leaves the old row out; no range at all means this month so far.
  assert.deepEqual(read.costs(store, CO, 'by-project', { from: '2026-11-01T00:00:00Z' }).map((r) => r.projectName), ['Lighthouse'])
  assert.deepEqual(read.costs(store, CO, 'by-agent', { to: '2026-10-31T00:00:00Z' }).map((r) => r.agentName), ['Freelancer'])
  assert.deepEqual(read.costs(store, CO, 'by-agent', {}, Date.parse('2026-11-30T00:00:00Z')).map((r) => r.eventCount), [1, 1])
  assert.deepEqual(read.costs(store, CO, 'by-agent', {}, Date.parse('2026-12-02T00:00:00Z')), [])
  assert.throws(() => read.costs(store, CO, 'by-agent', { from: 'yesterday' }), { status: 400, message: "invalid 'from' date" })
  assert.throws(() => read.costs(store, CO, 'by-agent', { period: 'week' }), { status: 400 })
  store.close()
})

test('the front door answers each path, with or without /api, and refuses the rest in plain words', async () => {
  const store = filled()
  assert.deepEqual(get(store, '/api/companies').body.map((c) => c.id), [CO])
  assert.equal(get(store, `/companies/${CO}`).body.name, 'The Yard')
  assert.equal(get(store, `/api/issues/LH-7`).body.id, JOB)
  assert.deepEqual(ids(get(store, `/api/issues/${JOB}/comments?limit=1`).body), ['c3'])
  assert.deepEqual(get(store, `/api/companies/${CO}/issues?status=done&view=compact&limit=5&projectId=${LIGHTHOUSE}`).body.map((j) => j.identifier), ['LH-8'])
  assert.deepEqual(get(store, `/api/companies/${CO}/issues?q=Plan%3A`).body.map((j) => j.identifier), ['LH-9'])
  assert.equal(get(store, `/api/issues/${JOB}/documents/plan`).body.title, 'Plan')
  assert.equal(get(store, `/api/issues/${JOB}/documents/plan/revisions`).body.length, 2)
  assert.deepEqual(ids(get(store, `/api/companies/${CO}/heartbeat-runs?agentId=${LEAD}&limit=20&summary=true`).body), [RUN2])
  assert.equal(get(store, `/api/companies/${CO}/chats/${FREE}`).body, null)
  assert.equal(get(store, `/api/companies/${CO}/costs/by-project?from=2026-11-01T00%3A00%3A00.000Z`).body[0].projectName, 'Lighthouse')
  assert.equal(get(store, `/api/companies/${CO}/costs/by-agent`, Date.parse('2026-12-02T00:00:00Z')).body.length, 0)
  // Every path the engine says it answers does answer.
  const fill = { '/companies/:id': CO, '/agents/:id': FREE, '/projects/:id': LIGHTHOUSE, '/issues/:id': JOB, '/heartbeat-runs/:id': RUN, '/routines/:id': ROUTINE, '/execution-workspaces/:id': FOLDER }
  for (const pattern of READ_PATHS) {
    let where = pattern.replace('/documents/:id', '/documents/plan').replace('/chats/:id', `/chats/${LEAD}`).replace('(by-agent|by-agent-model|by-provider|by-project)', 'by-provider')
    for (const [prefix, id] of Object.entries(fill)) where = where.replace(prefix, prefix.replace(':id', id))
    assert.equal(get(store, `/api${where}`).status, 200, where)
  }
  assert.ok(READ_PATHS.length >= 29)

  assert.deepEqual(get(store, '/api/issues/LH-999'), { status: 404, body: { error: 'Issue not found' } })
  assert.deepEqual(get(store, `/api/heartbeat-runs/${NOBODY}`), { status: 404, body: { error: 'Heartbeat run not found' } })
  assert.deepEqual(get(store, '/api/nope'), { status: 404, body: { error: 'API route not found' } })
  assert.deepEqual(get(store, `/api/companies/${CO}/issues?limit=0`), { status: 400, body: { error: 'limit must be a positive integer up to 1000' } })
  assert.equal(get(store, '/api/issues/%E0%A4%A').status, 400)
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(handle(store, method, `/api/issues/${JOB}`).status, 405)
  assert.equal(store.count('jobs'), 5, 'asking changes nothing')

  // The listener is there for later; started by hand it serves the same answers on this machine only.
  const server = await listen(store, 0)
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/issues/LH-7`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).id, JOB)
  assert.equal(server.address().address, '127.0.0.1')
  await new Promise((done) => server.close(done))
  store.close()
})

