/**
 * The phone door is the one part of Botyard that may face another device, so most of these
 * tests are about what it refuses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { noteArrival, readAway } from '../server/lib/away.mjs'
import { signPlay } from '../server/lib/edge.mjs'
import { waitingCount } from '../server/lib/cards.mjs'
import { phoneHandler, startPhoneDoor, tokenMatches } from '../server/phone.mjs'

const TOKEN = 'a'.repeat(40)
const JOB = '11111111-2222-4333-8444-555555555555'
const APPROVAL = '66666666-7777-4888-8999-000000000000'
const BOT = '77777777-8888-4999-8aaa-111111111111'
const REQUEST = '88888888-9999-4aaa-8bbb-222222222222'
const PROJECT = '99999999-aaaa-4bbb-8ccc-333333333333'
const QUESTION = 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444'
const ROUTINE = 'bbbbbbbb-cccc-4ddd-8eee-555555555555'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function engine({ calls = [], attentionDelay = 0, chatDelay = 0, summaryDelay = 0, state = {} } = {}) {
  const agents = [
    { id: 'lead', name: 'Lead', title: 'Studio director', role: 'ceo', status: 'idle', spentMonthlyCents: 120, adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5', cwd: '/secret', env: { KEY: 'hidden' } } },
    { id: 'bot', name: 'Scout', role: 'qa', status: 'idle', adapterType: 'codex_local', adapterConfig: { model: 'gpt-6-luna' } },
    { id: BOT, name: 'Critic', title: 'Reviewer', role: 'qa', status: 'idle', adapterType: 'codex_local', adapterConfig: { model: 'gpt-6.1-sol', cwd: '/secret' } },
  ]
  const issues = [
    { id: JOB, identifier: 'LH-1', title: 'Fix the map', status: 'in_progress', assigneeAgentId: 'bot', lastActivityAt: '2026-11-02T10:00:00Z', companyId: 'co' },
    { id: 'two', identifier: 'LH-2', title: 'Stuck job', status: 'blocked', assigneeAgentId: 'lead', lastActivityAt: '2026-11-02T09:00:00Z' },
    { id: 'three', identifier: 'LH-3', title: 'Old job', status: 'done', parentId: JOB, lastActivityAt: '2026-11-01T09:00:00Z' },
  ]
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/api', '') + new URL(url).search
    calls.push({ path, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    // The machine running the engine is off: every call fails, the way it does when the service is down.
    if (state.down) throw new Error('The engine is off')
    if (attentionDelay && path === '/companies/co/attention') {
      await new Promise((resolve) => setTimeout(resolve, attentionDelay))
    }
    if (chatDelay && path === '/companies/co/chats') {
      await new Promise((resolve) => setTimeout(resolve, chatDelay))
    }
    if (summaryDelay && path === '/companies/co/agents') {
      await new Promise((resolve) => setTimeout(resolve, summaryDelay))
    }
    if (path === '/companies') return json([{ id: 'co', status: 'active' }])
    if (path === '/companies/co') return json({ name: 'Acme Yard' })
    if (path === '/companies/co/agents') return json(agents)
    if (path === '/companies/co/issues' && init.method === 'POST') return json({ id: 'new', identifier: 'LH-4' }, 201)
    if (path === '/companies/co/issues') return json(issues)
    if (path === '/companies/co/approvals?status=pending') return json([{ id: APPROVAL, type: 'hire_agent', payload: { name: 'New bot' } }])
    if (path === '/companies/co/dashboard') return json({ costs: { monthSpendCents: 321 } })
    if (path === '/companies/co/sidebar-badges') return json({ failedRuns: 1 })
    if (path === '/companies/co/projects') return json([{ id: PROJECT, name: 'Lighthouse', secretPath: '/secret' }])
    if (path === '/companies/co/attention') return json({ items: [{ sourceKind: 'issue_thread_interaction', whyNow: 'Waiting on you', subject: { title: 'Which map?', metadata: { issueId: JOB } } }] })
    if (path === '/companies/co/costs/window-spend') return json([{ provider: 'anthropic', window: '7d', inputTokens: 100, outputTokens: 20, cachedInputTokens: 900, costCents: 0 }])
    if (path === `/issues/${JOB}/interactions` && init.method === 'GET') {
      return json([
        { id: QUESTION, kind: 'ask_user_questions', status: 'pending', title: 'Which map?', payload: { questions: [{ id: 'size', prompt: 'Size?', selectionMode: 'multi', required: true, options: [{ id: 's', label: 'Small', description: 'Fast' }] }] } },
        { id: 'c1', kind: 'request_confirmation', status: 'pending', title: 'Ship?', payload: { prompt: 'Ship it?', acceptLabel: 'Ship', rejectLabel: 'Hold' } },
        { id: 'c2', kind: 'request_item_verdicts', status: 'pending', payload: {} },
        { id: 'c3', kind: 'request_confirmation', status: 'answered', payload: {} },
      ])
    }
    if (path === `/issues/${JOB}/live-runs`) return json([{ id: 'run1', agentId: 'bot', status: 'running' }])
    if (path === `/issues/${JOB}/attachments`) return json([{ id: QUESTION, contentType: 'image/png', originalFilename: 'hud.png' }, { id: 'x', contentType: 'application/zip' }])
    if (path === `/attachments/${QUESTION}/content`) return new Response(Buffer.from('png'), { headers: { 'Content-Type': 'image/png' } })
    if (path === `/attachments/${REQUEST}/content`) return new Response('<script>', { headers: { 'Content-Type': 'text/html' } })
    if (path === '/heartbeat-runs/run1/cancel') return json({})
    if (path.startsWith('/companies/co/heartbeat-runs')) return json([{ id: 'old', issueId: JOB, agentId: 'bot', status: 'failed', error: 'Tests failed' }])
    if (path.startsWith(`/issues/${JOB}/interactions/${QUESTION}/`)) return json({})
    if (path === `/issues/${JOB}` && init.method === 'PATCH') return json({})
    if (path === '/companies/co/routines' && init.method === 'POST') return json({ id: ROUTINE }, 201)
    if (path === '/companies/co/routines') {
      return json([
        { id: ROUTINE, title: 'Nightly tests', status: 'active', assigneeAgentId: 'bot', projectId: PROJECT, lastTriggeredAt: '2026-11-02T03:00:00Z', triggers: [{ kind: 'schedule', cronExpression: '0 3 * * *', nextRunAt: '2026-11-03T03:00:00Z' }] },
        { id: 'gone', title: 'Old', status: 'archived' },
      ])
    }
    if (path.startsWith(`/routines/${ROUTINE}`)) return json({}, init.method === 'POST' ? 201 : 200)
    if (path === `/agents/${BOT}/pause` || path === `/agents/${BOT}/resume`) return json({})
    if (path === '/companies/co/live-runs') return json([{ agentId: 'bot' }])
    if (path === `/issues/${JOB}`) return json({ ...issues[0], description: 'Details' })
    if (path === `/issues/${JOB}/comments` && init.method === 'POST') return json({ id: 'c2' }, 201)
    if (path.startsWith(`/issues/${JOB}/comments`)) return json([{ id: 'c1', authorAgentId: 'bot', body: 'Working on it' }, { id: 'c0', body: 'Please do this' }])
    if (path === `/approvals/${APPROVAL}/approve`) return json({})
    if (path === '/companies/co/chats') return json([{ id: 'chat', conversationAgentId: BOT, lastActivityAt: '2026-11-02T10:00:00Z' }])
    if (path === `/agents/${BOT}`) return json(agents[2])
    if (path === `/companies/co/chats/${BOT}`) return json({ id: 'chat', conversationState: state.chatState || 'active' })
    if (path === '/issues/chat/live-runs') return json(state.chatRuns || [])
    if (path.startsWith('/issues/chat/comments?limit=')) {
      return json([
        ...(state.scriptNote ? [{ id: 'm5', authorType: 'user', body: 'The crew check found 1 thing to fix.\n\n<!-- myshop-script: Crew check -->' }] : []),
        { id: 'm3', authorType: 'system', body: 'Run retried' },
        { id: 'm2', authorType: 'agent', authorAgentId: BOT, body: 'On it' },
        { id: 'm1', authorType: 'user', body: 'Review this' },
      ])
    }
    if (path === '/issues/chat/comments' && init.method === 'POST') return json({ id: 'm4' }, 201)
    if (path === '/companies/co/issues/chat/attachments' && init.method === 'POST') return json({ id: QUESTION }, 201)
    if (path === '/issues/chat/attachments') return json([{ id: QUESTION, issueCommentId: 'm1', contentType: 'image/png', originalFilename: 'hud.png' }, { id: 'x', issueCommentId: 'm1', contentType: 'application/zip' }])
    // The map's sections, as the phone now reads them.
    const u = new URL(url)
    const plain = u.pathname.replace('/api', '')
    const param = (name) => u.searchParams.get(name)
    if (plain === '/companies/co/issues') {
      const statuses = param('status')?.split(',')
      return json(issues.filter((i) => (!statuses || statuses.includes(i.status)) && (!param('parentId') || i.parentId === param('parentId'))))
    }
    if (plain === '/companies/co/search') return json({ results: [{ type: 'issue', issue: issues[2], snippet: 'an old map fix' }, { type: 'project', project: {} }] })
    if (plain === '/companies/co/org') return json([])
    if (plain === '/companies/co/costs/by-agent') return json([{ agentId: BOT, inputTokens: 300, outputTokens: 30, eventCount: 4 }])
    if (plain === '/companies/co/costs/by-agent-model') return json([{ model: 'gpt-6.1-sol', inputTokens: 300, outputTokens: 30 }])
    if (plain === '/companies/co/costs/by-provider') return json([{ provider: 'openai', inputTokens: 300, outputTokens: 30 }])
    if (plain === '/companies/co/costs/by-project') return json([{ projectId: PROJECT, projectName: 'Lighthouse', inputTokens: 300, outputTokens: 30, eventCount: 4 }])
    if (path === '/companies/co/timeline') {
      return json({
        actors: [{ id: `agent:${BOT}`, type: 'agent', name: 'Critic' }],
        events: [{ actorId: `agent:${BOT}`, kind: 'commented', issueId: JOB, at: '2026-11-02T10:00:00Z' }, { actorId: `agent:${BOT}`, kind: 'commented', issueId: JOB, at: '2026-11-02T09:59:00Z' }],
        spans: [], edges: [],
      })
    }
    if (path === `/agents/${BOT}/config-revisions`) return json(Array.from({ length: 9 }, (_, n) => ({ id: `rev${n}`, createdAt: '2026-11-01T10:00:00Z', changedKeys: ['adapterConfig'], beforeConfig: { adapterConfig: { env: { KEY: 'hidden' } } }, afterConfig: {} })))
    if (plain === `/agents/${BOT}/instructions-bundle`) return json({ mode: 'external', entryFile: 'critic.md', rootPath: '/secret' })
    if (plain === `/agents/${BOT}/instructions-bundle/file`) return json({ content: 'hidden instructions '.repeat(500) })
    if (path.startsWith(`/agents/${BOT}/`)) return json([])
    if (path === `/heartbeat-runs/${REQUEST}`) return json({ id: REQUEST, companyId: 'co', agentId: 'bot', issueId: JOB, status: 'failed', error: 'You have hit your weekly limit · resets Mon 9am', logBytes: 0 })
    if (path === `/issues/${JOB}/documents`) return json([{ key: 'plan', title: 'Plan', body: 'x'.repeat(30_000), latestRevisionNumber: 2, updatedByAgentId: 'bot' }])
    if (path === `/issues/${JOB}/runs`) return json([{ runId: REQUEST, agentId: 'bot', status: 'succeeded', usageJson: { inputTokens: 10, outputTokens: 5 } }])
    if (path === `/issues/${JOB}/cost-summary`) return json({ inputTokens: 10, outputTokens: 5, costCents: 0, runCount: 1, runtimeMs: 4000 })
    if (path === `/projects/${PROJECT}`) return json({ id: PROJECT, companyId: 'co', name: 'Lighthouse', workspaces: [{ cwd: '/secret/lighthouse' }] })
    if (plain === '/companies/co/artifacts') return json({ artifacts: [{ id: 'a1', mediaKind: 'image', title: 'HUD', contentPath: `/api/attachments/${QUESTION}/content`, issue: { id: JOB, identifier: 'LH-1', title: 'Fix the map' }, createdByAgent: { name: 'Scout' } }], nextCursor: 'next1' })
    if (path === '/companies/co/members') return json([{ id: 'm1', user: { name: 'Owner', email: 'owner@example.com' }, membershipRole: 'owner', status: 'active' }])
    if (path === '/companies/co/invites') return json([{ id: 'i1', humanRole: 'viewer', expiresAt: '2026-12-01T00:00:00Z' }])
    if (path === '/companies/co/secrets') return json([{ name: 'GITHUB_TOKEN', description: 'push' }])
    return json({ error: 'nope' }, 404)
  }
  return { fetcher }
}

async function withDoor(run, { calls, away, edge, build, sessions, attentionDelay, chatDelay, summaryDelay, crew, research, faces, state = {}, warm = true } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-door-'))
  if (faces) {
    fs.mkdirSync(path.join(folder, 'faces'))
    for (const [name, bytes] of Object.entries(faces)) fs.writeFileSync(path.join(folder, 'faces', name), bytes)
  }
  if (crew) {
    fs.mkdirSync(path.join(folder, 'crew'))
    for (const [name, content] of Object.entries(crew)) fs.writeFileSync(path.join(folder, 'crew', name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  if (research) {
    fs.mkdirSync(path.join(folder, 'research', 'ideas'), { recursive: true })
    for (const [name, content] of Object.entries(research)) fs.writeFileSync(path.join(folder, 'research', name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  if (away) fs.writeFileSync(path.join(folder, 'away.json'), JSON.stringify(away))
  if (edge) fs.writeFileSync(path.join(folder, 'edge.json'), JSON.stringify(edge))
  if (build) {
    fs.mkdirSync(path.join(folder, 'previews', build.key, 'site'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'previews', build.key, 'manifest.json'), JSON.stringify({ job: JOB, name: 'Lighthouse', ok: true, builtAt: '2026-11-03T10:00:00Z' }))
  }
  const handler = phoneHandler({
    token: TOKEN,
    faces: { folder: path.join(folder, 'faces') },
    engine: engine({ calls, attentionDelay, chatDelay, summaryDelay, state }),
    sessions: sessions || (async () => [{ title: 'Harbour build', harness: 'claude-code', project: 'harbour' }]),
    previews: path.join(folder, 'previews'),
    devices: path.join(folder, 'devices.json'),
    guard: folder,
    away: path.join(folder, 'away.json'),
    edge: path.join(folder, 'edge.json'),
    crew: path.join(folder, 'crew'),
    plans: async () => ({ claude: { week: 0.4, resets: 1_794_589_200 }, codex: null, backup: null }),
    timers: async () => [{ id: 'acme-research', name: 'Researcher looks for money-making ideas', next: 1_794_589_200_000, last: null }],
    research: path.join(folder, 'research'),
    connectors: { crew: [{ id: 'bot-lead', name: 'Lead' }], options: { folder: path.join(folder, 'keys'), out: path.join(folder, 'bot-connectors'), engines: () => [] } },
  })
  handler.folder = folder
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The door warms the phone's first screen when it starts, so wait for that: a test that counts
  // The engine's calls then counts only the calls it makes itself. A test that wants the cold door
  // asks for `warm: false` and gets the answer before the warm has finished.
  if (warm) await handler.warmed
  const base = `http://127.0.0.1:${server.address().port}`
  const ask = (path, { token = TOKEN, method = 'GET', body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body))
  })
  try {
    await run(ask)
  } finally {
    server.close()
  }
}

test('the door will not start without a long token', () => {
  assert.throws(() => startPhoneDoor({}), /BOTYARD_PHONE_TOKEN/)
  assert.throws(() => startPhoneDoor({ BOTYARD_PHONE_TOKEN: 'short' }), /at least 32/)
})

test('tokenMatches needs the exact token in a bearer header', () => {
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true)
  assert.equal(tokenMatches(`Bearer ${TOKEN}x`, TOKEN), false)
  assert.equal(tokenMatches(TOKEN, TOKEN), false)
  assert.equal(tokenMatches(undefined, TOKEN), false)
})

test('a missing or wrong token is refused before anything else happens', async () => {
  const calls = []
  await withDoor(async (ask) => {
    // The door warms the phone's first screen when it starts, so this counts the calls the
    // refused request made, not the ones the warm made.
    const before = calls.length
    assert.equal((await ask('/v1/summary', { token: null })).status, 401)
    assert.equal((await ask('/v1/summary', { token: 'wrong' })).status, 401)
    assert.equal(calls.length, before)
  }, { calls })
})

test('a web page is refused even with the right token', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const before = calls.length
    const res = await ask('/v1/summary', { headers: { Origin: 'https://example.com' } })
    assert.equal(res.status, 403)
    assert.equal(calls.length, before)
  }, { calls })
})

test('guessing locks the address out, and the right token does not get past that', async () => {
  await withDoor(async (ask) => {
    for (let i = 0; i < 10; i += 1) await ask('/v1/summary', { token: `guess-${i}` })
    assert.equal((await ask('/v1/summary')).status, 429)
  })
})

test('only the named actions exist', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const before = calls.length
    for (const path of ['/', '/api/threads', '/v1', '/v1/companies', '/v1/../api/companies', '/v1/agents/lead/heartbeat/invoke']) {
      assert.equal((await ask(path)).status, 404, path)
    }
    assert.equal((await ask('/v1/summary', { method: 'POST', body: {} })).status, 404)
    assert.equal(calls.length, before)
  }, { calls })
})

test('the summary lists what needs you and leaves configuration out', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.equal(body.company, 'Acme Yard')
    assert.deepEqual(body.needsYou.map((n) => n.kind), ['approval', 'question', 'blocked', 'failed'])
    assert.equal(body.needsYou[1].id, JOB)
    assert.deepEqual(body.projects, [{ id: PROJECT, name: 'Lighthouse' }])
    assert.deepEqual(body.usage, [{ provider: 'anthropic', window: '7d', tokens: 120, cachedTokens: 900 }])
    assert.deepEqual(body.running.map((j) => [j.ref, j.bot]), [['LH-1', 'Scout']])
    assert.equal(body.bots.find((b) => b.name === 'Scout').status, 'running')
    assert.equal(body.spentCents, 321)
    assert.deepEqual(body.sessions.map((s) => s.project), ['harbour'])
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
  })
})

test('a slow session scan never holds up the summary', async () => {
  let scans = 0
  const started = Date.now()
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.deepEqual(body.sessions, [])
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2500, `the summary waited ${elapsed} ms for the scan`)
  }, { sessions: () => { scans += 1; return new Promise(() => {}) } })
  assert.equal(scans, 1)
})

test('the summary scans sessions once, then serves the remembered list', async () => {
  let scans = 0
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.deepEqual(first.body.sessions.map((s) => s.project), ['harbour'])
    const second = await ask('/v1/summary')
    assert.deepEqual(second.body.sessions.map((s) => s.project), ['harbour'])
  }, {
    sessions: async () => {
      scans += 1
      return [{ title: 'Harbour build', harness: 'claude-code', project: 'harbour' }]
    },
  })
  assert.equal(scans, 1)
})

test('a scan that fails leaves the summary standing', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/summary')
    assert.equal(status, 200)
    assert.deepEqual(body.sessions, [])
  }, { sessions: async () => { throw new Error('no harness') } })
})

test('a slow attention feed does not hold the summary past a second', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.equal(first.body.needsYou.some((n) => n.kind === 'question'), false)
    // The answer comes from the cache the door warmed when it started, so the slow feed is never
    // waited for.
    assert.ok(Date.now() - started < 500, `the first summary waited ${Date.now() - started} ms`)
    await new Promise((resolve) => setTimeout(resolve, 600))
    // The cached answer is served at once; the refreshed answer lands on the next call.
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const latest = await ask('/v1/summary')
    assert.equal(latest.body.needsYou.some((n) => n.kind === 'question'), true)
  }, { attentionDelay: 1100 })
})

test('the summary is served at once without waiting for the engine, then refreshed behind it', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.ok(Date.now() - started < 500, `the first summary took ${Date.now() - started} ms`)
    const second = await ask('/v1/summary')
    assert.equal(second.status, 200)
    assert.ok(Date.now() - started < 500, `the cached summary took ${Date.now() - started} ms`)
    // The background refresh lands on the next call after the engine has answered.
    await new Promise((resolve) => setTimeout(resolve, 4000))
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const latest = await ask('/v1/summary')
    assert.equal(latest.status, 200)
    assert.equal(latest.body.needsYou.some((n) => n.kind === 'question'), true)
  }, { attentionDelay: 2000 })
})

test('the chat list is served at once and refreshed behind the request', async () => {
  await withDoor(async (ask) => {
    const started = Date.now()
    const first = await ask('/v1/chats')
    assert.equal(first.status, 200)
    // The answer is at once, and it still carries the bots: a fast answer with nothing in it is
    // an empty studio, which is worse than a slow one.
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
    assert.ok(Date.now() - started < 500, `the first chat list took ${Date.now() - started} ms`)
    const second = await ask('/v1/chats')
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
  }, { chatDelay: 900 })
})

test('a slow the engine still gives the phone the bots and the company', async () => {
  // The door has no answer yet and the engine takes longer than the old one-second wait, so the
  // phone waits for the answer rather than being shown an empty studio.
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.equal(first.status, 200)
    assert.equal(first.body.company, 'Acme Yard')
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
    assert.deepEqual(first.body.needsYou.map((n) => n.kind), ['approval', 'question', 'blocked', 'failed'])
  }, { warm: false, summaryDelay: 1200 })
})

test('a slow the engine still gives the phone the bots in the chat list', async () => {
  await withDoor(async (ask) => {
    const first = await ask('/v1/chats')
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
  }, { warm: false, chatDelay: 1200 })
})

test('an engine that is down is answered with the error, not an empty studio', async () => {
  await withDoor(async (ask) => {
    const first = await ask('/v1/summary')
    assert.ok(first.status >= 400, `the summary answered ${first.status}`)
    assert.match(first.body.error, /engine is not running/)
    const chats = await ask('/v1/chats')
    assert.ok(chats.status >= 400, `the chat list answered ${chats.status}`)
    assert.match(chats.body.error, /engine is not running/)
  }, { state: { down: true } })
})

test('the last good answer is kept, and the door says what went wrong', async () => {
  const state = { down: false }
  await withDoor(async (ask) => {
    const good = await ask('/v1/summary')
    assert.equal(good.status, 200)
    assert.deepEqual(good.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
    state.down = true
    // The next call refreshes behind the request and finds the engine down.
    await ask('/v1/summary')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = await ask('/v1/summary')
    assert.equal(after.status, 200)
    // The studio is still there, and the phone is told what went wrong.
    assert.deepEqual(after.body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
    assert.match(after.body.error, /engine is not running/)
  }, { state })
})

test('the models screen reads every bot\'s model and the free list, and leaves configuration out', async () => {
  const crew = {
    'setup-bots.py': "FREE = [('opencode/deepseek-v4.1-flash-free', 'deepseek', 'strong'), ('opencode/beam-free', 'beam', 'light')]\n",
    'free-out.json': { 'opencode/beam-free': { until: Math.floor(Date.now() / 1000) + 3600, error: 'did not answer' } },
    'fallback.log': '2026-11-10 01:21 Freelancer moved from opencode/deepseek-v4.1-flash-free to opencode/beam-free\n',
  }
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/models', { token: 'wrong' })).status, 401)
    assert.equal((await ask('/v1/models', { method: 'POST', body: {} })).status, 404)
    const { status, body } = await ask('/v1/models')
    assert.equal(status, 200)
    assert.deepEqual(body.bots.map((b) => [b.name, b.label, b.where, b.status]), [['Critic', 'GPT 6.1 Sol', 'Codex', 'idle'], ['Lead', 'Sonnet 5.5', 'Claude', 'idle'], ['Scout', 'GPT 6 Luna', 'Codex', 'idle']])
    assert.deepEqual(body.free.map((m) => [m.label, m.state]), [['DeepSeek V4.1 Flash, free', 'unchecked'], ['Beam, free', 'aside']])
    assert.equal(body.subscriptions.claude.week, 0.4)
    assert.equal(body.switches[0].text, 'Freelancer moved from DeepSeek V4.1 Flash, free to Beam, free')
    assert.equal(body.health.tone, 'warn')
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
    assert.equal(JSON.stringify(body).includes('setup-bots'), false)
  }, { crew })
})

test('the manager view needs the token and says who is on what', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/manager', { token: 'wrong' })).status, 401)
    assert.equal((await ask('/v1/manager', { method: 'POST', body: {} })).status, 404)
    const { status, body } = await ask('/v1/manager')
    assert.equal(status, 200)
    assert.deepEqual(body.now.map((w) => [w.bot, w.ref, w.stage]), [['Scout', 'LH-1', 'Building']])
    assert.ok(body.lines.some((l) => l.ref === 'LH-2' && l.stage === 'blocked'))
    assert.ok(body.needsYou.some((n) => n.kind === 'approval'))
    assert.ok(body.trouble.some((t) => /1 job is blocked/.test(t.text)))
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
  })
})

test('a new job goes to the director and a bad one is refused', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const made = await ask('/v1/jobs', { method: 'POST', body: { title: 'Fix the map', description: 'It is broken' } })
    assert.equal(made.status, 201)
    assert.equal(made.body.ref, 'LH-4')
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: '   ' } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x'.repeat(201) } })).status, 400)
  }, { calls })
  const created = calls.find((c) => c.method === 'POST')
  assert.equal(created.body.assigneeAgentId, 'lead')
  assert.equal(created.body.status, 'todo')
})

test('a job shows its comments, and an unusual id never reaches the engine', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const job = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(job.body.comments.map((c) => c.from), ['Scout', 'You'])
    assert.equal((await ask('/v1/jobs/not-an-id')).status, 400)
    assert.equal((await ask('/v1/jobs/..%2F..%2Fcompanies')).status, 400)
  }, { calls })
  assert.equal(calls.some((c) => c.path.includes('not-an-id') || c.path.includes('companies/co/secrets')), false)
})

test('comments and approvals pass through by name', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/comments`, { method: 'POST', body: { text: 'Carry on' } })).status, 201)
    assert.equal((await ask(`/v1/jobs/${JOB}/comments`, { method: 'POST', body: { text: '' } })).status, 400)
    assert.equal((await ask(`/v1/approvals/${APPROVAL}/approve`, { method: 'POST', body: { note: 'Fine' } })).status, 200)
    assert.equal((await ask(`/v1/approvals/${APPROVAL}/delete`, { method: 'POST', body: {} })).status, 404)
  }, { calls })
  assert.deepEqual(calls.find((c) => c.path.endsWith('/approve')).body, { decisionNote: 'Fine' })
})

test('the chat list shows who can be talked to and leaves configuration out', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask('/v1/chats')
    assert.deepEqual(body.bots.map((b) => b.name), ['Lead', 'Scout', 'Critic'])
    const critic = body.bots.find((b) => b.name === 'Critic')
    assert.equal(critic.lastActiveAt, '2026-11-02T10:00:00Z')
    assert.equal(critic.lastMessage.text, 'On it')
    assert.equal(critic.lastMessage.mine, false)
    assert.equal(body.bots.find((b) => b.name === 'Lead').lastMessage, null)
    assert.equal(JSON.stringify(body).includes('/secret'), false)
  })
})

test('a conversation reads oldest first and says when the bot is working', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/chats/${BOT}`)
    assert.equal(body.working, true)
    assert.deepEqual(body.messages.map((m) => [m.from, m.mine]), [['You', true], ['Critic', false], ['Botyard', false]])
  })
})

test('a bot is working while a run of its is going on the chat, whatever the conversation state says', async () => {
  for (const [runs, working] of [[[{ agentId: BOT, status: 'running' }], true], [[{ agentId: BOT, status: 'queued' }], true], [[{ agentId: 'someone-else', status: 'running' }], false], [[], false]]) {
    await withDoor(async (ask) => {
      assert.equal((await ask(`/v1/chats/${BOT}`)).body.working, working, JSON.stringify(runs))
    }, { state: { chatState: 'waiting', chatRuns: runs } })
  }
})

test('a script\'s message is a note under the script\'s name, without its signature, whatever prefix it signs with', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/chats/${BOT}`)
    const note = body.messages.find((m) => m.id === 'm5')
    assert.deepEqual([note.from, note.mine, note.note, note.text], ['Crew check', false, true, 'The crew check found 1 thing to fix.'])
    assert.equal(body.messages.find((m) => m.id === 'm3').note, true)
    assert.equal(body.messages.find((m) => m.id === 'm2').note, false)
  }, { state: { scriptNote: true } })
})

test('a chat message opens the chat and carries the phone\'s request id', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const sent = await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'Hello', requestId: REQUEST } })
    assert.equal(sent.status, 201)
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'Hello' } })).status, 400)
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: ' ', requestId: REQUEST } })).status, 400)
    assert.equal((await ask('/v1/chats/not-a-bot')).status, 400)
  }, { calls })
  const message = calls.find((c) => c.path === '/issues/chat/comments' && c.method === 'POST')
  assert.deepEqual(message.body, { body: 'Hello', clientRequestId: REQUEST })
})

test('a chat picture goes through the door to the bot\'s own conversation, and the message names it', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const png = Buffer.from('\x89PNG picture bytes')
    const up = await ask(`/v1/chats/${BOT}/pictures?name=hud.png`, { method: 'POST', raw: png, headers: { 'Content-Type': 'image/png' } })
    assert.equal(up.status, 201, JSON.stringify(up.body))
    assert.deepEqual(up.body, { id: QUESTION, name: 'hud.png' })
    const sent = await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'What is wrong here?', requestId: REQUEST, pictures: [QUESTION] } })
    assert.equal(sent.status, 201)
    // A picture alone is a message too.
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: '', requestId: REQUEST, pictures: [QUESTION] } })).status, 201)
    // The thread shows each message's pictures, and only pictures.
    const thread = await ask(`/v1/chats/${BOT}`)
    assert.deepEqual(thread.body.messages.find((m) => m.id === 'm1').pictures, [{ id: QUESTION, name: 'hud.png' }])
    assert.deepEqual(thread.body.messages.find((m) => m.id === 'm2').pictures, [])
  }, { calls })
  const upload = calls.find((c) => c.path === '/companies/co/issues/chat/attachments')
  const file = upload.body.get('file')
  assert.equal(file.type, 'image/png')
  assert.equal(file.name, 'hud.png')
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '\x89PNG picture bytes')
  const message = calls.find((c) => c.path === '/issues/chat/comments' && c.method === 'POST')
  assert.deepEqual(message.body, { body: 'What is wrong here?', clientRequestId: REQUEST, attachmentIds: [QUESTION] })
})

test('the door takes only pictures for a chat, under 10 MB, from a paired phone, with the same checks as every route', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const send = (opts) => ask(`/v1/chats/${BOT}/pictures?name=a.png`, { method: 'POST', raw: Buffer.from('png'), ...opts, headers: { 'Content-Type': 'image/png', ...opts?.headers } })
    assert.equal((await send({ headers: { 'Content-Type': 'text/html' } })).status, 415)
    assert.equal((await send({ headers: { 'Content-Type': 'image/svg+xml' } })).status, 415, 'a drawing that can carry a script is not a picture here')
    assert.equal((await send({ headers: { 'Content-Type': 'application/pdf' } })).status, 415)
    assert.equal((await send({ raw: Buffer.alloc(0) })).status, 400)
    assert.equal((await send({ raw: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 413)
    assert.equal((await send({ token: 'wrong'.repeat(10) })).status, 401)
    assert.equal((await send({ token: '' })).status, 401)
    assert.equal((await send({ headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await ask('/v1/chats/not-a-bot/pictures?name=a.png', { method: 'POST', raw: Buffer.from('png'), headers: { 'Content-Type': 'image/png' } })).status, 400)
    assert.equal((await ask(`/v1/chats/${BOT}/pictures`, { headers: { 'Content-Type': 'image/png' } })).status, 404, 'there is nothing to read here')
    // A message names only picture ids, and not too many.
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'x', requestId: REQUEST, pictures: ['../etc'] } })).status, 400)
    assert.equal((await ask(`/v1/chats/${BOT}/messages`, { method: 'POST', body: { text: 'x', requestId: REQUEST, pictures: Array(7).fill(QUESTION) } })).status, 400)
  }, { calls })
  assert.equal(calls.filter((c) => c.path.endsWith('/attachments') && c.method === 'POST').length, 0, 'nothing refused reached the engine')
})

test('an oversized body is refused', async () => {
  await withDoor(async (ask) => {
    const res = await ask('/v1/jobs', { method: 'POST', body: { title: 'x', description: 'y'.repeat(20 * 1024) } })
    assert.equal(res.status, 413)
  })
})

test('a job shows its questions, and only the forms the app can answer', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(body.questions.map((q) => q.kind), ['choice', 'confirm'])
    assert.equal(body.questions[0].items[0].multiple, true)
    assert.equal(body.questions[0].items[0].options[0].hint, 'Fast')
    assert.equal(body.questions[1].accept, 'Ship')
  })
})

test('a job says whether it is live', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.equal(body.run.live, true)
    assert.equal(body.run.why, '')
  })
})

test('stopping a job cancels its live runs and leaves the job open', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const stopped = await ask(`/v1/jobs/${JOB}/stop`, { method: 'POST', body: {} })
    assert.equal(stopped.body.stopped, 1)
    assert.ok(calls.some((c) => c.path === '/heartbeat-runs/run1/cancel' && c.method === 'POST'))
    assert.equal(calls.some((c) => c.path === `/issues/${JOB}` && c.method === 'PATCH'), false)
  }, { calls })
})

test('a job can be cancelled and reopened', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/cancel`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`/v1/jobs/${JOB}/reopen`, { method: 'POST', body: {} })).status, 200)
    const sent = calls.filter((c) => c.path === `/issues/${JOB}` && c.method === 'PATCH').map((c) => c.body.status)
    assert.deepEqual(sent, ['cancelled', 'todo'])
  }, { calls })
})

test('a bot can be paused and resumed', async () => {
  const calls = []
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/bots/${BOT}/pause`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`/v1/bots/${BOT}/resume`, { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(calls.filter((c) => c.path.startsWith('/agents/') && c.method === 'POST').map((c) => c.path.split('/').pop()), ['pause', 'resume'])
    assert.equal((await ask('/v1/bots/not-a-bot/pause', { method: 'POST', body: {} })).status, 400)
    assert.equal((await ask(`/v1/bots/${BOT}/delete`, { method: 'POST', body: {} })).status, 404)
  }, { calls })
})

test('questions are answered with only the fields the engine expects', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const path = `/v1/jobs/${JOB}/questions/${QUESTION}`
    const answers = [{ questionId: 'size', optionIds: ['s'], extra: 'dropped' }]
    assert.equal((await ask(`${path}/respond`, { method: 'POST', body: { answers } })).status, 200)
    assert.deepEqual(calls.find((c) => c.path.endsWith('/respond')).body, { answers: [{ questionId: 'size', optionIds: ['s'] }] })
    assert.equal((await ask(`${path}/respond`, { method: 'POST', body: {} })).status, 400)
    assert.equal((await ask(`${path}/accept`, { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask(`${path}/reject`, { method: 'POST', body: { reason: 'Not yet' } })).status, 200)
    assert.equal(calls.find((c) => c.path.endsWith('/reject')).body.reason, 'Not yet')
    assert.equal((await ask(`/v1/jobs/${JOB}/questions/nope/accept`, { method: 'POST', body: {} })).status, 400)
  }, { calls })
})

test('a new job can name its project, bot and priority', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const made = await ask('/v1/jobs', { method: 'POST', body: { title: 'Polish', projectId: PROJECT, botId: BOT, priority: 'high' } })
    assert.equal(made.status, 201)
    const sent = calls.find((c) => c.path === '/companies/co/issues' && c.method === 'POST').body
    assert.equal(sent.projectId, PROJECT)
    assert.equal(sent.assigneeAgentId, BOT)
    assert.equal(sent.priority, 'high')
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', projectId: QUESTION } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', botId: QUESTION } })).status, 400)
    assert.equal((await ask('/v1/jobs', { method: 'POST', body: { title: 'x', priority: 'urgent' } })).status, 400)
  }, { calls })
})

test('a job lists only image proof, and images come through as images', async () => {
  await withDoor(async (ask) => {
    const { body } = await ask(`/v1/jobs/${JOB}`)
    assert.deepEqual(body.proof, [{ id: QUESTION, name: 'hud.png' }])
    assert.equal(body.changes, null)
    assert.deepEqual(body.previews, [])
    assert.equal((await ask('/v1/proof/not-an-id')).status, 400)
    assert.equal((await ask(`/v1/proof/${REQUEST}`)).status, 415)
  })
})

test('a job with no branch has no changes to read', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask(`/v1/jobs/${JOB}/changes`)).status, 404)
  })
})

test('each device gets its own key, and it can be cut off alone', async () => {
  await withDoor(async (ask) => {
    const phone = (await ask('/v1/devices', { method: 'POST', body: { name: 'Pixel' } })).body
    const laptop = (await ask('/v1/devices', { method: 'POST', body: { name: 'Laptop' } })).body
    assert.equal((await ask('/v1/summary', { token: phone.key })).status, 200)
    const list = (await ask('/v1/devices', { token: phone.key })).body
    assert.equal(list.current, phone.id)
    assert.deepEqual(list.devices.map((d) => d.name), ['Pixel', 'Laptop'])
    assert.equal(JSON.stringify(list).includes('hash'), false)
    assert.equal((await ask(`/v1/devices/${phone.id}/revoke`, { method: 'POST', body: {}, token: phone.key })).status, 409)
    assert.equal((await ask(`/v1/devices/${laptop.id}/revoke`, { method: 'POST', body: {}, token: phone.key })).status, 200)
    assert.equal((await ask('/v1/summary', { token: laptop.key })).status, 401)
  })
})

test('the shared key can only be retired from a device, and stops working after', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/devices/retire-shared', { method: 'POST', body: {} })).status, 409)
    const { key } = (await ask('/v1/devices', { method: 'POST', body: {} })).body
    assert.equal((await ask('/v1/devices/retire-shared', { method: 'POST', body: {}, token: key })).status, 200)
    assert.equal((await ask('/v1/summary')).status, 401)
    assert.equal((await ask('/v1/summary', { token: key })).status, 200)
    assert.equal((await ask('/v1/devices', { token: key })).body.sharedActive, false)
  })
})

test('routines list what is live, and only fixed schedules can be set', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const { body } = await ask('/v1/routines')
    assert.deepEqual(body.routines.map((r) => r.title), ['Nightly tests'])
    assert.equal(body.routines[0].bot, 'Scout')
    assert.equal(body.routines[0].project, 'Lighthouse')
    const made = await ask('/v1/routines', { method: 'POST', body: { title: 'Nightly', schedule: 'nightly', timezone: 'Europe/Berlin', projectId: PROJECT } })
    assert.equal(made.status, 201)
    assert.equal(calls.find((c) => c.path.endsWith('/triggers')).body.cronExpression, '0 3 * * *')
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: '* * * * *' } })).status, 400)
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: 'constructor' } })).status, 400)
    assert.equal((await ask('/v1/routines', { method: 'POST', body: { title: 'x', schedule: 'nightly', timezone: '../etc' } })).status, 400)
    for (const action of ['run', 'pause', 'resume', 'remove']) assert.equal((await ask(`/v1/routines/${ROUTINE}/${action}`, { method: 'POST', body: {} })).status, 200)
    assert.deepEqual(calls.filter((c) => c.path === `/routines/${ROUTINE}` && c.method === 'PATCH').map((c) => c.body.status), ['paused', 'active', 'archived'])
    assert.equal((await ask('/v1/routines/nope/run', { method: 'POST', body: {} })).status, 400)
  }, { calls })
})

test('the token guard is set through the door and reported with the summary', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/summary')).body.guard.enabled, false)
    const set = await ask('/v1/guard', { method: 'POST', body: { enabled: true, limit: 5000000 } })
    assert.deepEqual([set.body.enabled, set.body.limit], [true, 5000000])
    assert.equal((await ask('/v1/guard', { method: 'POST', body: { enabled: true, limit: -4 } })).body.limit, 0)
  })
})

test('the day report covers finished jobs and tokens', async () => {
  await withDoor(async (ask) => {
    const { report } = (await ask('/v1/summary')).body
    assert.equal(typeof report.finishedCount, 'number')
    assert.ok(Array.isArray(report.tokens))
  })
})

const TUNNEL = { address: '10.88.0.1', phone: '10.88.0.2', port: 51820, interface: 'acme-test', endpoint: '203.0.113.3', phoneEndpoint: '203.0.113.3' }

test('the app learns the tunnel address once away access is set up', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.away, null)
    assert.equal((await ask('/v1/hello', { token: 'wrong' })).status, 401)
    assert.equal((await ask('/v1/devices')).body.away, null)
  })
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.away, '10.88.0.1:5288')
    assert.deepEqual((await ask('/v1/devices')).body.away, { address: '10.88.0.1', up: false, changed: false })
    assert.ok(!(await ask('/v1/summary')).body.needsYou.some((item) => /address changed/.test(item.title)))
  }, { away: TUNNEL })
})

test('a tunnel address outside the private ranges is ignored', async () => {
  for (const address of ['8.8.8.8', '127.0.0.1', 'evil.example', '10.0.0.1:80']) {
    await withDoor(async (ask) => {
      assert.equal((await ask('/v1/hello')).body.away, null)
    }, { away: { ...TUNNEL, address } })
  }
})

test('a changed home address asks the owner to update the phone, until the phone comes through', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-away-'))
  const file = path.join(folder, 'away.json')
  fs.writeFileSync(file, JSON.stringify({ ...TUNNEL, endpoint: '203.0.113.9' }))
  await withDoor(async (ask) => {
    const notice = (await ask('/v1/summary')).body.needsYou.find((item) => /address changed/.test(item.title))
    assert.match(notice.detail, /203\.0\.113\.9:51820/)
    assert.equal((await ask('/v1/devices')).body.away.changed, true)
  }, { away: { ...TUNNEL, endpoint: '203.0.113.9' } })
  noteArrival(file, '192.168.0.4')
  assert.equal(readAway(file).changed, true)
  noteArrival(file, '10.88.0.1')
  assert.equal(readAway(file).changed, true)
  noteArrival(file, '::ffff:10.88.0.2')
  assert.equal(readAway(file).changed, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).phoneEndpoint, '203.0.113.9')
})

const EDGE = { studio: 'studio.example.org', play: 'play.example.org', gate: 'c'.repeat(64) }
const VIA_EDGE = (client) => ({ 'x-botyard-edge': '1', 'x-botyard-client': client })

test('a device with a key learns the Cloudflare address and its gate, and nothing without a key', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/hello')).body.edge, null)
  })
  await withDoor(async (ask) => {
    assert.deepEqual((await ask('/v1/hello')).body.edge, { host: 'https://studio.example.org', gate: EDGE.gate })
    assert.equal((await ask('/v1/hello', { token: '' })).body.edge, undefined)
  }, { edge: EDGE })
  for (const broken of [{ ...EDGE, gate: 'short' }, { ...EDGE, studio: 'evil host' }, { ...EDGE, play: '' }]) {
    await withDoor(async (ask) => {
      assert.equal((await ask('/v1/hello')).body.edge, null)
    }, { edge: broken })
  }
})

test('build links through Cloudflare are signed for that build alone', async () => {
  const key = 'a1'.repeat(16)
  await withDoor(async (ask) => {
    const direct = (await ask(`/v1/jobs/${JOB}`)).body.previews[0].url
    assert.match(direct, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/open/${key}$`))
    const cloud = (await ask(`/v1/jobs/${JOB}`, { headers: VIA_EDGE('90.1.2.3') })).body.previews[0].url
    assert.equal(cloud, `https://play.example.org/open/${key}?g=${signPlay(EDGE.gate, key)}`)
    assert.notEqual(signPlay(EDGE.gate, key), signPlay(EDGE.gate, 'b2'.repeat(16)))
  }, { edge: EDGE, build: { key } })
})

test('through Cloudflare, wrong keys lock out that phone and not every phone', async () => {
  await withDoor(async (ask) => {
    for (let i = 0; i < 10; i += 1) assert.equal((await ask('/v1/hello', { token: 'wrong', headers: VIA_EDGE('90.1.2.3') })).status, 401)
    assert.equal((await ask('/v1/hello', { headers: VIA_EDGE('90.1.2.3') })).status, 429)
    assert.equal((await ask('/v1/hello', { headers: VIA_EDGE('90.9.9.9') })).status, 200)
    assert.equal((await ask('/v1/hello')).status, 200)
  }, { edge: EDGE })
})

// ── the map's sections on the phone ──────────────────────────────────────────────────

test('the bots list says each state, engine and why, flags waste, and leaves settings out', async () => {
  const until = Math.floor(Date.now() / 1000) + 3600
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/bots')
    assert.equal(status, 200)
    const critic = body.bots.find((b) => b.name === 'Critic')
    assert.equal(critic.engine, 'Codex')
    assert.equal(critic.why, 'Codex subscription')
    assert.equal(critic.tokensToday, 330)
    assert.equal(critic.waste.flagged, true)
    assert.equal(body.bots.find((b) => b.name === 'Scout').state, 'Working')
    assert.equal(body.org, undefined)
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
  }, { crew: { 'waste.json': { at: Math.floor(Date.now() / 1000), bots: { Critic: { runs: 10, wasted: 4, causes: { 'Rate limit exceeded': 4 } } } }, 'rested.json': { [BOT]: { until, why: 'Codex ran out' } } } })
})

test('a bot\'s page has its runs in plain words and only the name of its instructions', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask(`/v1/bots/${BOT}`)
    assert.equal(status, 200)
    assert.equal(body.name, 'Critic')
    assert.deepEqual(body.instructions, { file: 'critic.md', managed: false })
    assert.equal(body.revisions.length, 5)
    assert.equal(JSON.stringify(body).includes('hidden'), false)
    assert.equal(JSON.stringify(body).includes('/secret'), false)
    assert.equal((await ask('/v1/bots/lead')).status, 400)
  })
})

test('runs, one run and the activity read through the door', async () => {
  await withDoor(async (ask) => {
    const runs = await ask('/v1/runs?status=failed')
    assert.equal(runs.status, 200)
    assert.deepEqual(runs.body.runs.map((r) => [r.bot, r.why]), [['Scout', 'Tests failed']])
    const one = await ask(`/v1/runs/${REQUEST}`)
    assert.equal(one.body.why, "Claude's limit ran out (it resets Mon 9am)")
    assert.equal((await ask('/v1/runs/nope')).status, 400)
    const activity = await ask('/v1/activity')
    assert.deepEqual(activity.body.items.map((i) => [i.who, i.what, i.times]), [['Critic', 'commented on', 2]])
  })
})

test('the job list filters by pile, searches, and refuses a bad filter before the engine', async () => {
  const calls = []
  await withDoor(async (ask) => {
    const active = await ask('/v1/jobs')
    assert.deepEqual(active.body.jobs.map((j) => j.title), ['Fix the map', 'Stuck job'])
    const done = await ask('/v1/jobs?pile=done')
    assert.deepEqual(done.body.jobs.map((j) => j.title), ['Old job'])
    const found = await ask('/v1/jobs?q=map')
    assert.deepEqual(found.body.jobs.map((j) => j.snippet), ['an old map fix'])
    const before = calls.length
    assert.equal((await ask('/v1/jobs?pile=everything')).status, 400)
    assert.equal((await ask('/v1/jobs?bot=lead')).status, 400)
    assert.equal(calls.length, before)
  }, { calls })
})

test('a job\'s page gains its sub-jobs, documents cut short, runs and cost', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask(`/v1/jobs/${JOB}/more`)
    assert.equal(status, 200)
    assert.deepEqual(body.children.map((c) => c.title), ['Old job'])
    assert.equal(body.documents[0].body.length, 12_000)
    assert.equal(body.documents[0].trimmed, true)
    assert.equal(body.documents[0].by, 'Scout')
    assert.equal(body.runs.length, 1)
    assert.deepEqual(body.cost, { tokens: 15, cached: 0, cents: 0, runs: 1, seconds: 4, withSubJobs: false })
    assert.deepEqual(body.files.map((f) => f.name), ['hud.png', 'File'])
    assert.equal(JSON.stringify(body).includes('/secret'), false)
  })
})

test('projects come in the owner\'s ranking, which the phone saves as the map does', async () => {
  await withDoor(async (ask) => {
    const first = await ask('/v1/projects')
    assert.deepEqual(first.body.projects.map((p) => [p.name, p.shelved]), [['Lighthouse', false]])
    await ask('/v1/guard', { method: 'POST', body: { ranked: ['Lighthouse'], shelved: ['Lighthouse'] } })
    const saved = await ask('/v1/projects')
    assert.deepEqual(saved.body.ranked, ['Lighthouse'])
    assert.equal(saved.body.projects[0].shelved, true)
    const page = await ask(`/v1/projects/${PROJECT}`)
    assert.equal(page.status, 200)
    assert.equal(page.body.name, 'Lighthouse')
    assert.equal(page.body.shelved, true)
    assert.deepEqual(page.body.routines.map((r) => r.title), ['Nightly tests'])
    assert.deepEqual(page.body.spend, { tokens: 330, runs: 4, cents: 0 })
    assert.equal(page.body.folders, undefined)
    assert.equal(JSON.stringify(page.body).includes('/secret'), false)
  })
})

test('the improvements read through the door, the same list the PC page shows, and nothing writes', async () => {
  const items = [{ id: 'IMP-1', title: 'Old briefs stay', path: 'briefs', evidence: '212 files', fix: 'Move them', who: 'Checker', status: 'accepted', job: 'LH-961', added: 5 }]
  await withDoor(async (ask) => {
    const page = await ask('/v1/improvements')
    assert.equal(page.status, 200)
    assert.deepEqual(page.body.items.map((i) => [i.id, i.status, i.job, i.path]), [['IMP-1', 'accepted', 'LH-961', 'briefs']])
    assert.equal(page.body.counts.accepted, 1)
    assert.notEqual((await ask('/v1/improvements', { method: 'POST', body: {} })).status, 200)
    assert.equal((await ask('/v1/improvements/IMP-1', { method: 'POST', body: { action: 'reject' } })).status, 400)
    const done = await ask('/v1/improvements/IMP-1', { method: 'POST', body: { action: 'reject', reason: 'No need' } })
    assert.equal(done.status, 200)
    const after = (await ask('/v1/improvements')).body.items[0]
    assert.deepEqual([after.status, after.decidedBy, after.reason], ['rejected', 'owner', 'No need'])
    assert.equal(after.history.length, 0)
  }, { crew: { 'improvements.json': items } })
})

test('spend, timers and the library read through the door', async () => {
  await withDoor(async (ask) => {
    const spend = await ask('/v1/spend')
    assert.deepEqual(spend.body.bots.map((b) => [b.name, b.tokens]), [['Critic', 330]])
    assert.deepEqual(spend.body.projects.map((p) => p.name), ['Lighthouse'])
    const timers = await ask('/v1/timers')
    assert.deepEqual(timers.body.timers.map((t) => t.id), ['acme-research'])
    const library = await ask('/v1/library')
    assert.deepEqual(library.body.items.map((i) => [i.title, i.file, i.bot]), [['HUD', QUESTION, 'Scout']])
    assert.equal(library.body.next, 'next1')
    assert.equal((await ask('/v1/library?kind=everything')).status, 400)
  })
})

test('the company reads members and invites, without emails or secrets', async () => {
  await withDoor(async (ask) => {
    const { status, body } = await ask('/v1/company')
    assert.equal(status, 200)
    assert.equal(body.name, 'Acme Yard')
    assert.deepEqual(body.members.map((m) => [m.name, m.role]), [['Owner', 'owner']])
    assert.deepEqual(body.invites.map((i) => i.role), ['viewer'])
    assert.equal(JSON.stringify(body).includes('owner@example.com'), false)
    assert.equal(JSON.stringify(body).includes('GITHUB_TOKEN'), false)
  })
})

test('the new sections need the token', async () => {
  await withDoor(async (ask) => {
    for (const path of ['/v1/bots', `/v1/bots/${BOT}`, '/v1/runs', '/v1/activity', '/v1/spend', '/v1/improvements', '/v1/jobs', `/v1/jobs/${JOB}/more`, '/v1/projects', `/v1/projects/${PROJECT}`, '/v1/timers', '/v1/library', '/v1/money', '/v1/company']) {
      // Past ten wrong tries the address is locked out, which refuses as surely.
      assert.ok([401, 429].includes((await ask(path, { token: '' })).status), path)
    }
  })
})

test('the phone lists the connectors and changes who may use one; adding and signing in stay on the PC', async () => {
  let folder = ''
  await withDoor(async (ask) => {
    assert.deepEqual((await ask('/v1/connectors')).body.connectors, [])
    // The door reads the same store the PC writes.
    const keys = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('studio-door-')).map((d) => path.join(os.tmpdir(), d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    folder = path.join(keys, 'keys')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'connectors.json'), JSON.stringify({ connectors: { docs: { id: 'docs', name: 'Docs', url: 'https://docs.test/mcp', auth: 'open', tools: [{ name: 'search', about: 'Search', readOnly: true }, { name: 'write', about: 'Write a page' }], writes: [], bots: {}, signedInAt: 1 } }, passes: {} }))
    const list = (await ask('/v1/connectors')).body
    assert.equal(list.connectors[0].name, 'Docs')
    assert.equal(list.connectors[0].bots[0].level, 'off')
    const changed = (await ask('/v1/connectors/docs/access', { method: 'POST', body: { bots: { 'bot-lead': 'write' }, writes: ['write'] } })).body
    assert.equal(changed.bots[0].level, 'write')
    assert.equal(changed.tools.find((t) => t.name === 'write').allowed, true)
    assert.match(JSON.parse(fs.readFileSync(path.join(keys, 'bot-connectors', 'lead.claude.json'), 'utf8')).mcpServers.docs.url, /\/api\/mcp\/docs\//)
    // Nothing on the phone adds a service or starts a sign-in.
    assert.equal((await ask('/v1/connectors', { method: 'POST', body: { from: 'github', key: 'x' } })).status, 404)
    assert.equal((await ask('/v1/connectors/nope/access', { method: 'POST', body: {} })).status, 404)
  })
})

test('the phone gets the same bot portraits the map shows: which bots have one, and each picture by its name only', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  await withDoor(async (ask) => {
    const listed = await ask('/v1/faces')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.faces, { lead: 'lead', bot: 'scout' }, 'a bot with no picture is left out; a file that is no portrait is not offered')
    assert.equal((await ask('/v1/faces/nobody')).status, 404)
    assert.equal((await ask('/v1/faces/..%2Fdevices.json')).status, 404, 'only a name from the folder is read, never a path')
    assert.equal((await ask('/v1/faces', { token: '' })).status, 401)
  }, { faces: { 'lead.png': png, 'scout.webp': png, 'notes.txt': 'x' } })
})

test('a paired phone reaches an own page\'s list and its own calls, never its files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'door-own-'))
  const dir = path.join(home, 'pages', 'notes')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'page.json'), JSON.stringify({ title: 'Notes', script: 'page.js', server: 'server.mjs' }))
  fs.writeFileSync(path.join(dir, 'page.js'), 'export const mount = () => {}')
  fs.writeFileSync(path.join(dir, 'server.mjs'), "export default ({ method, path, query, body }) => ({ body: { method, path, to: query.to || '', got: body } })")
  const saved = process.env.BOTYARD_HOME
  process.env.BOTYARD_HOME = home
  try {
    await withDoor(async (ask) => {
      const list = await ask('/v1/own')
      assert.deepEqual(list.body.pages.map((p) => p.name), ['notes'])
      assert.deepEqual((await ask('/v1/own/notes/api/hello?to=me')).body, { method: 'GET', path: '/hello', to: 'me', got: {} })
      assert.deepEqual((await ask('/v1/own/notes/api/save', { method: 'POST', body: { a: 1 } })).body.got, { a: 1 })
      assert.equal((await ask('/v1/own/notes/files/page.js')).status, 404)
      assert.equal((await ask('/v1/own/Bad/api/x')).status, 404)
    })
  } finally {
    if (saved === undefined) delete process.env.BOTYARD_HOME
    else process.env.BOTYARD_HOME = saved
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the phone gets the crew map\'s tree on /v1/flow, with the summary\'s Needs-you list, and only with its key', async () => {
  await withDoor(async (ask) => {
    assert.equal((await ask('/v1/flow', { token: null })).status, 401)
    const res = await ask('/v1/flow?window=7d')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const body = res.body
    assert.ok(Array.isArray(body.nodes), 'the tree has its nodes')
    assert.ok(Array.isArray(body.edges), 'and its lines')
    const summary = (await ask('/v1/summary')).body
    // One Needs-you number: the cards waiting for the owner's answer, the same as the phone's badge.
    assert.equal(body.needs, waitingCount(summary.needsYou))
  })
})
