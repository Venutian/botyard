/**
 * The Bots, Runs and Money readers, against a fake engine and a fake crew folder. Most of what
 * they do is leave things out: adapter settings, other files of the bundle folder, keys in logs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activityPage, botList, botPage, moneyView, plainError, readRested, readWaste, readableLog,
  resetBotSession, restoreInstructions, rollbackBot, runDetail, runList, saveInstructions,
} from '../server/lib/crew.mjs'

const LEAD = '11111111-1111-4111-8111-111111111111'
const FRED = '22222222-2222-4222-8222-222222222222'
const CLAUDE = '33333333-3333-4333-8333-333333333333'
const GONE = '44444444-4444-4444-8444-444444444444'
const JOB = '55555555-5555-4555-8555-555555555555'
const RUN = '66666666-6666-4666-8666-666666666666'
const REV = '77777777-7777-4777-8777-777777777777'
const PROJECT = '88888888-8888-4888-8888-888888888888'
const NOW = Date.parse('2026-11-11T15:00:00Z')

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function folder({ waste, rested, thinker = {}, freeOut = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'))
  if (waste) fs.writeFileSync(path.join(dir, 'waste.json'), JSON.stringify(waste))
  if (rested) fs.writeFileSync(path.join(dir, 'rested.json'), JSON.stringify(rested))
  fs.writeFileSync(path.join(dir, 'thinker.json'), JSON.stringify(thinker))
  fs.writeFileSync(path.join(dir, 'free-out.json'), JSON.stringify(freeOut))
  fs.writeFileSync(path.join(dir, 'pace.json'), JSON.stringify({ week: 0.4, cap: 0.9, perHourNow: 0.01, perHourAllowed: 0.02, resets: NOW / 1000 + 3600, at: NOW / 1000 }))
  return dir
}

function engine({ calls = [], bundleMode = 'external', log = '' } = {}) {
  const agents = [
    { id: LEAD, name: 'Lead', role: 'ceo', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5', env: { KEY: 'secret-value' } } },
    { id: FRED, name: 'Freelancer', status: 'idle', reportsTo: LEAD, adapterType: 'opencode_local', adapterConfig: { model: 'opencode/deepseek-v4.1-flash-free' } },
    { id: CLAUDE, name: 'Senior', status: 'paused', reportsTo: LEAD, adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5' } },
  ]
  const runs = [
    { id: RUN, agentId: FRED, issueId: JOB, status: 'failed', error: 'Rate limit exceeded: free-models-per-day-high-balance.', inputTokens: '1000', outputTokens: '500', cachedInputTokens: '9000', costUsd: '0', startedAt: '2026-11-11T14:00:00Z', finishedAt: '2026-11-11T14:02:00Z' },
    { id: 'r2', agentId: LEAD, issueId: JOB, status: 'succeeded', inputTokens: '10', outputTokens: '5', startedAt: '2026-11-11T13:00:00Z', finishedAt: '2026-11-11T13:00:30Z' },
    { id: 'r3', agentId: GONE, issueId: JOB, status: 'failed', startedAt: '2026-11-11T12:00:00Z' },
  ]
  const fetcher = async (url, init) => {
    const u = new URL(url)
    const p = u.pathname.replace('/api', '') + u.search
    calls.push({ path: p, method: init.method, body: init.body && JSON.parse(init.body) })
    const plain = u.pathname.replace('/api', '')
    if (p === '/companies') return json([{ id: 'co', status: 'active' }])
    if (p === '/companies/co/agents') return json(agents)
    if (p === '/companies/co/live-runs') return json([])
    if (plain === '/companies/co/issues' && !u.searchParams.has('q')) return json([{ id: JOB, identifier: 'LH-7', title: 'Fix the map', status: 'in_progress', projectId: PROJECT }])
    if (p === '/companies/co/projects') return json([{ id: PROJECT, name: 'Lighthouse' }])
    if (p === '/companies/co/org') return json([{ id: LEAD, name: 'Lead', reports: [{ id: FRED, name: 'Freelancer', reports: [] }, { id: GONE, name: 'Retired', reports: [] }] }])
    if (plain === '/companies/co/costs/by-agent') return json([{ agentId: FRED, inputTokens: 100, outputTokens: 50, cachedInputTokens: 7, costCents: 0, eventCount: 3 }, { agentId: GONE, inputTokens: 9 }])
    if (plain === '/companies/co/costs/by-agent-model') return json([{ model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 5 }, { model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1 }])
    if (plain === '/companies/co/costs/by-provider') return json([{ provider: 'anthropic', biller: 'a', inputTokens: 3, outputTokens: 0 }, { provider: 'anthropic', biller: 'b', inputTokens: 2, outputTokens: 0 }, { provider: 'nvidia', inputTokens: 0, outputTokens: 0 }])
    if (plain === '/companies/co/costs/by-project') return json([{ projectName: null, inputTokens: 4, outputTokens: 0 }])
    if (p === '/companies/co/costs/window-spend') return json([{ provider: 'anthropic', window: '5h', inputTokens: 10, outputTokens: 1 }, { provider: 'anthropic', window: '7d', inputTokens: 100, outputTokens: 1 }])
    if (p === '/companies/co/costs/quota-windows') return json([{ provider: 'anthropic', ok: false, windows: [] }])
    if (plain === '/companies/co/heartbeat-runs') return json(u.searchParams.get('agentId') ? runs.filter((r) => r.agentId === u.searchParams.get('agentId')) : runs)
    if (p === `/agents/${FRED}`) return json({ ...agents[1], companyId: 'co' })
    if (p === `/agents/${FRED}/task-sessions`) return json([{ id: 's1', sessionParamsJson: { cwd: '/secret' } }])
    if (p === `/agents/${FRED}/skills`) return json({ desiredSkills: ['studio/crew/job-closing'], entries: [{ key: 'other', targetPath: '/secret' }] })
    if (p === `/agents/${FRED}/config-revisions`) return json([{ id: REV, createdAt: '2026-11-10T10:00:00Z', source: 'patch', changedKeys: ['adapterConfig'], beforeConfig: { adapterType: 'opencode_local', adapterConfig: { model: 'nvidia/minimaxai/minimax-m3.1-flash', env: { TOKEN: 'secret-value' } } }, afterConfig: { adapterType: 'opencode_local', adapterConfig: { model: 'opencode/deepseek-v4.1-flash-free' } } }])
    if (plain === `/agents/${FRED}/instructions-bundle`) return json({ mode: bundleMode, entryFile: 'freelancer.md', rootPath: '/secret', files: [{ path: 'claude-token' }] })
    if (plain === `/agents/${FRED}/instructions-bundle/file` && init.method === 'GET') return json({ path: 'freelancer.md', content: '# Freelancer\nBuild things.', revisionId: bundleMode === 'managed' ? REV : undefined })
    if (plain === `/agents/${FRED}/instructions-bundle/history`) return json({ revisions: [{ id: REV, createdAt: '2026-11-10T10:00:00Z', source: 'board' }] })
    if (p === `/heartbeat-runs/${RUN}`) return json({ ...runs[0], companyId: 'co', logBytes: log.length, usageJson: { model: 'opencode/deepseek-v4.1-flash-free' }, invocationSource: 'assignment' })
    if (plain === `/heartbeat-runs/${RUN}/log`) return json({ content: log })
    if (p === '/companies/co/timeline') {
      return json({
        actors: [{ id: `agent:${LEAD}`, type: 'agent', name: 'Lead' }, { id: `agent:${FRED}`, type: 'agent', name: 'Freelancer' }, { id: 'user:local-board', type: 'user', name: 'Board' }],
        events: [
          { actorId: 'user:local-board', kind: 'created', issueId: JOB, at: '2026-11-11T10:00:00.000Z' },
          { actorId: `agent:${FRED}`, kind: 'commented', issueId: JOB, at: '2026-11-11T11:00:00Z' },
          { actorId: `agent:${FRED}`, kind: 'commented', issueId: JOB, at: '2026-11-11T11:01:00Z' },
          { actorId: `agent:${FRED}`, kind: 'commented', issueId: JOB, at: '2026-11-11T11:02:00Z' },
        ],
        edges: [{ fromActorId: 'user:local-board', toActorId: `agent:${LEAD}`, issueId: JOB, at: '2026-11-11T10:00:00.500Z', kind: 'assignment' }],
        spans: [{ actorId: `agent:${FRED}`, issueId: JOB, runId: RUN, status: 'failed', start: '2026-11-11T12:00:00Z', end: '2026-11-11T12:05:00Z' }, { actorId: `agent:${LEAD}`, status: 'succeeded', issueId: JOB, start: '2026-11-11T12:00:00Z' }],
      })
    }
    if (init.method !== 'GET') return json({ ok: true })
    return json({ error: 'not found' }, 404)
  }
  return { fetcher, calls }
}

test('engine errors read as the limit or the cause, in plain words', () => {
  assert.equal(plainError("Claude run failed: subtype=success: You've hit your weekly limit · resets Nov 13, 6pm (Europe/London)"), "Claude's limit ran out (it resets Nov 13, 6pm)")
  assert.equal(plainError('Too Many Requests: {"status":429}'), "A free model's limit was reached")
  assert.equal(plainError('Configured OpenCode model is unavailable: openrouter/x:free'), 'That free model is no longer offered')
  assert.equal(plainError('nvidia/minimaxai/minimax-m3.1-flash ran out; continuing the same session on opencode/longcat-2.5-free.'), 'MiniMax M3.1 Flash via NVIDIA ran out; carried on with LongCat 2.5, free')
  assert.equal(plainError('Cancelled by a board operator'), 'Stopped by hand')
  assert.equal(plainError(''), '')
})

test('waste is read from health.py, with plain causes and a flag past 30 % of 8 runs', () => {
  const dir = folder({ waste: { at: NOW / 1000 - 60, bots: {
    Checker: { runs: 10, wasted: 4, tokens: 100, wastedTokens: 40, causes: { 'Cancelled by a board operator': 2, 'Rate limit exceeded: x': 1, 'Too Many Requests': 1, 'Adapter failed': 1 } },
    Reviewer: { runs: 2, wasted: 2, tokens: 5, wastedTokens: 5, causes: {} },
  } } })
  const waste = readWaste(dir, NOW)
  assert.equal(waste.stale, false)
  assert.equal(waste.bots.Checker.flagged, true)
  assert.equal(waste.bots.Checker.share, 0.4)
  assert.deepEqual(waste.bots.Checker.causes[0], { text: 'Stopped by hand', count: 2 })
  assert.deepEqual(waste.bots.Checker.causes[1], { text: "A free model's limit was reached", count: 2 })
  assert.equal(waste.bots.Checker.causes.length, 3)
  assert.equal(waste.bots.Reviewer.flagged, false, 'two runs are too few to judge')
  assert.deepEqual(readWaste(path.join(dir, 'nowhere'), NOW), { at: null, stale: true, bots: {} })
})

test('a rested bot says until when, and one whose rest is over is dropped', () => {
  const dir = folder({ rested: { [CLAUDE]: { name: 'Senior', until: NOW / 1000 + 7200, why: "You've hit your weekly limit · resets Nov 13, 6pm" }, [LEAD]: { name: 'Lead', until: NOW / 1000 - 1 } } })
  const rested = readRested(dir, NOW)
  assert.deepEqual(Object.keys(rested), [CLAUDE])
  assert.match(rested[CLAUDE].text, /^Resting until \w{3} \d{2}:\d{2}$/)
  assert.match(rested[CLAUDE].why, /Claude's limit ran out/)
})

test('the bot list says each engine and why, resting, waste and the org, and no settings', async () => {
  const { fetcher } = engine()
  const dir = folder({
    thinker: { on: 'gemini', back: NOW / 1000 + 3600, claude: ['Lead'] },
    freeOut: { 'opencode/deepseek-v4.1-flash-free': { until: NOW / 1000 + 600 } },
    rested: { [CLAUDE]: { until: NOW / 1000 + 600 } },
    waste: { at: NOW / 1000, bots: { Freelancer: { runs: 9, wasted: 3, causes: {} } } },
  })
  const list = await botList({ fetcher, folder: dir, now: NOW })
  const by = Object.fromEntries(list.bots.map((b) => [b.name, b]))
  assert.equal(by['Lead'].engine, 'Claude')
  assert.match(by['Lead'].why, /^Codex and Antigravity are out, so it runs on Claude until/)
  assert.equal(by.Freelancer.engine, 'Free models')
  assert.match(by.Freelancer.why, /set aside until/)
  assert.equal(by.Freelancer.tokensToday, 150)
  assert.equal(by.Freelancer.waste.flagged, true)
  assert.equal(by.Senior.resting, true)
  assert.match(by.Senior.state, /^Resting until/)
  assert.equal(by.Senior.why, 'Claude subscription')
  assert.deepEqual(list.org, [{ id: LEAD, name: 'Lead', reports: [{ id: FRED, name: 'Freelancer', reports: [] }] }])
  assert.doesNotMatch(JSON.stringify(list), /secret-value|adapterConfig/)
})

test("a bot's page has its runs, cost, skills, revisions and only its instructions file", async () => {
  const { fetcher, calls } = engine()
  const page = await botPage(FRED, { fetcher, folder: folder(), now: NOW })
  assert.equal(page.reportsTo, 'Lead')
  assert.equal(page.runs.length, 1)
  assert.deepEqual({ ref: page.runs[0].job.ref, why: page.runs[0].why, tokens: page.runs[0].tokens, seconds: page.runs[0].seconds }, { ref: 'LH-7', why: "A free model's limit was reached", tokens: 1500, seconds: 120 })
  assert.deepEqual(page.today, { tokens: 150, cached: 7, cents: 0, runs: 3 })
  assert.deepEqual(page.skills, ['job-closing'])
  assert.equal(page.sessions, 1)
  assert.equal(page.revisions[0].what, 'Changed engine settings')
  assert.match(page.revisions[0].detail, /^model MiniMax M3.1 Flash via NVIDIA to DeepSeek V4.1 Flash, free$/)
  assert.deepEqual({ file: page.instructions.file, managed: page.instructions.managed, content: page.instructions.content }, { file: 'freelancer.md', managed: false, content: '# Freelancer\nBuild things.' })
  assert.ok(!calls.some((c) => c.path.includes('/history')), 'an external bundle has no history to ask for')
  assert.doesNotMatch(JSON.stringify(page), /secret|claude-token/)
  await assert.rejects(botPage('nope', { fetcher }), /not a bot id/)
})

test('a managed bundle brings its history; edits and restores go on top of the revision read', async () => {
  const { fetcher, calls } = engine({ bundleMode: 'managed' })
  const page = await botPage(FRED, { fetcher, folder: folder(), now: NOW })
  assert.equal(page.instructions.managed, true)
  assert.equal(page.instructions.revisionId, REV)
  assert.deepEqual(page.instructions.history, [{ id: REV, at: '2026-11-10T10:00:00Z', by: 'You', bytes: 0 }])
  await saveInstructions(FRED, { content: '# Freelancer v2', baseRevisionId: REV }, { fetcher })
  assert.deepEqual(calls.find((c) => c.method === 'PUT'), { path: `/agents/${FRED}/instructions-bundle/file`, method: 'PUT', body: { path: 'freelancer.md', content: '# Freelancer v2', baseRevisionId: REV } })
  await restoreInstructions(FRED, { revisionId: REV, baseRevisionId: REV }, { fetcher })
  assert.ok(calls.some((c) => c.path === `/agents/${FRED}/instructions-bundle/restore` && c.body.revisionId === REV))
  await assert.rejects(saveInstructions(FRED, { content: '  ' }, { fetcher }), /empty/)
})

test('instructions in the crew folder are not written through the engine', async () => {
  const { fetcher, calls } = engine()
  await assert.rejects(saveInstructions(FRED, { content: 'x' }, { fetcher }), /cannot be changed in Botyard/)
  assert.ok(!calls.some((c) => c.method === 'PUT'))
})

test('reset and roll back post to the bot, and refuse what is not an id', async () => {
  const { fetcher, calls } = engine()
  await resetBotSession(FRED, { fetcher })
  await rollbackBot(FRED, REV, { fetcher })
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), [`/agents/${FRED}/runtime-state/reset-session`, `/agents/${FRED}/config-revisions/${REV}/rollback`])
  await assert.rejects(rollbackBot(FRED, '../x', { fetcher }), /revision id/)
  await assert.rejects(resetBotSession('x', { fetcher }), /bot id/)
})

test('runs across the crew are filtered by bot and how they ended, and retired bots are left out', async () => {
  const { fetcher, calls } = engine()
  const all = await runList({ fetcher })
  assert.deepEqual(all.runs.map((r) => r.id), [RUN, 'r2'])
  assert.equal(all.bots.length, 3)
  const failed = await runList({ fetcher, status: 'failed' })
  assert.deepEqual(failed.runs.map((r) => r.id), [RUN])
  await runList({ fetcher, bot: LEAD })
  assert.ok(calls.some((c) => c.path.includes(`agentId=${LEAD}`)))
  await assert.rejects(runList({ fetcher, bot: '1&x=2' }), /bot id/)
})

test("a run's log is the bot's words and commands, with keys hidden", async () => {
  const rec = (stream, chunk) => JSON.stringify({ stream, chunk })
  const claude = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the map.' }, { type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" x' } }] } })
  const opencode = JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'echo sk-abcdefghijklmnopqrstuv' } } } })
  const log = ['{"partial', rec('stdout', `${claude}\n${opencode.slice(0, 20)}`), rec('stdout', `${opencode.slice(20)}\n`), rec('stdout', '{"type":"step_start"}\n[engine] Resuming session\n'), rec('stderr', 'Every free model is out now\n')].join('\n')
  const lines = readableLog(log)
  assert.deepEqual(lines, [
    { kind: 'said', text: 'Looking at the map.' },
    { kind: 'tool', text: 'Bash: curl -H "Authorization: Bearer [hidden]" x' },
    { kind: 'tool', text: 'bash: echo [hidden]' },
    { kind: 'note', text: 'Resuming session' },
    { kind: 'error', text: 'Every free model is out now' },
  ])
  const { fetcher } = engine({ log })
  const run = await runDetail(RUN, { fetcher })
  assert.equal(run.model, 'DeepSeek V4.1 Flash, free')
  assert.equal(run.started, 'Given a job')
  assert.equal(run.job.ref, 'LH-7')
  assert.ok(run.log.length >= 4)
})

test('the activity timeline names who did what to which job, a run of comments as one line', async () => {
  const { fetcher } = engine()
  const page = await activityPage({ fetcher })
  assert.deepEqual(page.items.map((i) => [i.who, i.what, i.to, i.job?.ref, i.times]), [
    ['Freelancer', 'had a run fail on', '', 'LH-7', 1],
    ['Freelancer', 'commented on', '', 'LH-7', 3],
    ['You or a script', 'made', 'Lead', 'LH-7', 1],
  ])
  const freelancer = await activityPage({ fetcher, bot: LEAD })
  assert.equal(freelancer.items.length, 0)
})

test('money is counted in tokens four ways, with names merged and the pace from the crew folder', async () => {
  const { fetcher } = engine()
  const money = await moneyView({ fetcher, folder: folder(), now: NOW })
  assert.deepEqual(money.bots.map((b) => [b.name, b.tokens]), [['Freelancer', 150]])
  assert.deepEqual(money.models, [{ name: 'Opus 5.5', tokens: 12, cached: 0, cents: 0, runs: 0 }])
  assert.deepEqual(money.providers.map((p) => [p.name, p.tokens]), [['Claude', 5]])
  assert.deepEqual(money.projects.map((p) => p.name), ['No project'])
  assert.deepEqual(money.windows.rows, [{ name: 'Claude', '5h': 11, '7d': 101 }])
  assert.deepEqual(money.quotas, [])
  assert.equal(money.pace.week, 0.4)
  assert.equal(money.priced, false)
})
