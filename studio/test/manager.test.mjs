/**
 * The manager's view is worked out from job titles, check comments and the crew's logs. These tests
 * pin how one piece of work is read through its rounds, and that the answer stays small.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildManager, kindOf, readCrewFiles, verdictOf, workName, workToClear } from '../server/lib/manager.mjs'

const NOW = Date.parse('2026-11-10T13:00:00Z')
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
const HARBOUR = 'p-harbour'
const NIGHT = 'p-night'

const AGENTS = [
  { id: 'lead', name: 'Lead', title: 'Studio director', status: 'idle', adapterType: 'claude_local', adapterConfig: { model: 'claude-sonnet-5-5', cwd: '/secret' } },
  { id: 'freelancer', name: 'Freelancer The Builder', status: 'idle', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/deepseek-v4.1-flash-free' } },
  { id: 'checker', name: 'Checker', status: 'idle', adapterType: 'opencode_local', adapterConfig: { model: 'opencode/glm-5.3-flash-free' } },
  { id: 'senior', name: 'Senior Builder', status: 'paused', pauseReason: 'manual', adapterType: 'claude_local', adapterConfig: { model: 'claude-fable-5-1' } },
]
const PROJECTS = [{ id: HARBOUR, name: 'Harbour' }, { id: NIGHT, name: 'Quay' }]

let number = 0
const job = (title, status, bot, extra = {}) => {
  number += 1
  return {
    id: `job-${number}`, identifier: `LH-${number}`, issueNumber: number, title, status, assigneeAgentId: bot, projectId: HARBOUR,
    createdAt: ago(600), startedAt: ago(500), completedAt: status === 'done' ? ago(60) : null, lastActivityAt: ago(60), ...extra,
  }
}
const noFiles = () => ({ merges: [], stopped: [], switches: [], pace: {}, thinker: {}, freeOut: {}, freeOk: {}, notInMain: {}, rested: {} })
const view = (issues, extra = {}) => buildManager({ agents: AGENTS, issues, projects: PROJECTS, files: noFiles(), now: NOW, ...extra })
const lineOf = (manager, ref) => manager.lines.find((l) => l.ref === ref)

test('a job is known by the way the crew names it', () => {
  assert.deepEqual(kindOf('Check LH-12: Town kit'), { kind: 'check', of: 'LH-12', ruling: false })
  assert.deepEqual(kindOf('Check LH-12 (Lead): Town kit'), { kind: 'check', of: 'LH-12', ruling: true })
  assert.deepEqual(kindOf('Fix 2 of Town kit'), { kind: 'fix', round: 2 })
  assert.deepEqual(kindOf('Ruling: how the line is measured'), { kind: 'ruling' })
  assert.deepEqual(kindOf('Town kit (v2)'), { kind: 'build' })
  assert.equal(workName('Fix 2 of Town kit (v3)'), 'Town kit')
})

test('a verdict is read from the newest thing a bot said, and never guessed', () => {
  const said = (body, authorType = 'agent') => ({ authorType, body })
  assert.equal(verdictOf([said('## Workspace Ready'), said('# Report\n\n## OUTCOME: PASS\n')]), 'pass')
  assert.equal(verdictOf([said('## OUTCOME: BLOCKING\n1. the test fails')]), 'blocking')
  assert.equal(verdictOf([said('VERDICT: FAIL')]), 'blocking')
  assert.equal(verdictOf([said('**Verdict:** PASS')]), 'pass')
  assert.equal(verdictOf([said('Two BLOCKING findings, see below')]), 'blocking')
  assert.equal(verdictOf([said('VERDICT: PASS', 'user'), said('still reading')]), null)
  assert.equal(verdictOf([]), null)
})

test('one piece of work is one line through its build, checks and fix rounds', () => {
  number = 0
  const build = job('Town kit', 'done', 'freelancer')
  const check = job('Check LH-1: Town kit', 'done', 'checker', { completedAt: ago(50) })
  const fix = job('Fix 1 of Town kit', 'done', 'freelancer', { createdAt: ago(45), completedAt: ago(30) })
  const recheck = job('Check LH-3: Fix 1 of Town kit', 'done', 'checker', { completedAt: ago(20) })
  const lead = job('Check LH-3 (Lead): Fix 1 of Town kit', 'in_progress', 'lead', { startedAt: ago(5) })
  const manager = view([build, check, fix, recheck, lead], { verdicts: new Map([[check.id, 'blocking'], [recheck.id, 'pass']]) })
  assert.equal(manager.lines.length, 1)
  const line = manager.lines[0]
  assert.equal(line.ref, 'LH-3')
  assert.equal(line.title, 'Town kit')
  assert.deepEqual(line.steps, ['done', 'done', 'now', 'wait', 'wait'])
  assert.equal(line.stage, 'ruling')
  assert.equal(line.fixes, 1)
  assert.equal(line.note, 'Lead is checking it')
  assert.equal(line.late, false)
  assert.deepEqual(manager.now.map((w) => [w.bot, w.ref, w.stage, w.minutes, w.model]), [['Lead', 'LH-5', 'Checking LH-3', 5, 'Sonnet 5.5']])
  // The short title first, the code after it.
  assert.match(manager.state, /^1 bot is working: Lead checking Town kit LH-3\./)
})

test('work that failed its check is trouble until something newer starts', () => {
  number = 0
  const build = job('Frame clock', 'done', 'freelancer')
  const check = job('Check LH-1: Frame clock', 'done', 'checker', { completedAt: ago(40) })
  const failed = view([build, check], { verdicts: new Map([[check.id, 'blocking']]) })
  assert.equal(lineOf(failed, 'LH-1').stage, 'fix')
  assert.ok(failed.trouble.some((t) => t.level === 'bad' && /LH-1 failed its check/.test(t.text)))
  const followUp = job('Frame clock: review fixes', 'in_progress', 'freelancer', { createdAt: ago(30), startedAt: ago(29) })
  const handled = view([build, check, followUp], { verdicts: new Map([[check.id, 'blocking']]) })
  assert.equal(lineOf(handled, 'LH-1').stage, 'replaced')
  assert.equal(handled.trouble.some((t) => /LH-1/.test(t.text)), false)
})

test('merged and pushed come from the merge log and from git', () => {
  number = 0
  const logged = job('Feel fixes', 'done', 'senior')
  const branched = job('Far ground', 'done', 'senior')
  const pushed = job('Shadow casters', 'done', 'senior')
  const local = job('Story bible', 'done', 'freelancer', { projectId: NIGHT })
  const files = { ...noFiles(), merges: [{ at: NOW - 60_000, text: 'LH-1 95c1d67ef into harbour main: merged' }] }
  const repos = new Map([
    [HARBOUR, { unpushed: 3, remote: true, merged: new Set(['LH-2', 'LH-3']), pushed: new Set(['LH-3']) }],
    [NIGHT, { unpushed: null, remote: false, merged: new Set(['LH-4']), pushed: new Set() }],
  ])
  const manager = view([logged, branched, pushed, local], { files, repos })
  assert.deepEqual(['LH-1', 'LH-2', 'LH-3', 'LH-4'].map((ref) => lineOf(manager, ref).stage), ['merged', 'merged', 'pushed', 'kept'])
  assert.equal(lineOf(manager, 'LH-3').open, false)
  assert.equal(manager.projects.find((p) => p.id === HARBOUR).unpushed, 3)
  assert.equal(manager.projects.find((p) => p.id === NIGHT).unpushed, null)
  assert.ok(manager.feed.some((e) => e.kind === 'merged' && e.text === 'LH-1 merged into Harbour'))
  assert.ok(manager.trouble.some((t) => /2 finished pieces of work are merged but not pushed/.test(t.text)))
})

test('old finished work drops off, open work stays, and late work is said', () => {
  number = 0
  const old = job('Last week', 'done', 'freelancer', { completedAt: ago(3000), lastActivityAt: ago(10) })
  const waiting = job('Critic read', 'todo', 'lead', { createdAt: ago(3000), startedAt: null })
  const blocked = job('Release prep', 'blocked', 'senior')
  const manager = view([old, waiting, blocked])
  assert.deepEqual(manager.lines.map((l) => [l.ref, l.stage, l.late]), [['LH-3', 'blocked', false], ['LH-2', 'queued', true]])
  assert.ok(manager.trouble.some((t) => t.level === 'bad' && t.text === '1 job is blocked: LH-3'))
  assert.ok(manager.trouble.some((t) => t.level === 'warn' && /LH-2 has been waiting for 3000 minutes/.test(t.text)))
  assert.equal(manager.state, 'Nobody is working right now. 1 thing needs a look.')
})

test('each bot stands in the project of its job, and a paused one says why', () => {
  number = 0
  const running = job('Scene art', 'in_progress', 'freelancer', { projectId: NIGHT, startedAt: ago(14) })
  const earlier = job('Town kit', 'done', 'senior')
  const files = { ...noFiles(), pace: { week: 0.9, cap: 1, resets: (NOW + 3 * 86_400_000) / 1000 }, thinker: { on: 'gemini' }, freeOut: { 'opencode/beam-free': { until: NOW / 1000 + 600, error: 'out' } }, freeOk: {} }
  const manager = view([running, earlier], { files, live: [{ agentId: 'freelancer' }] })
  const bot = (id) => manager.bots.find((b) => b.id === id)
  assert.deepEqual([bot('freelancer').status, bot('freelancer').projectId, bot('freelancer').job.ref, bot('freelancer').job.minutes], ['running', NIGHT, 'LH-1', 14])
  assert.equal(bot('freelancer').model, 'DeepSeek V4.1 Flash, free')
  assert.equal(bot('senior').projectId, HARBOUR)
  assert.match(bot('senior').why, /^Claude's week is 90% used; back /)
  assert.equal(bot('lead').projectId, '')
  assert.deepEqual(manager.projects.map((p) => [p.name, p.running, p.bots]), [['Quay', 1, ['Freelancer The Builder']], ['Harbour', 0, ['Senior Builder']]])
  assert.ok(manager.trouble.some((t) => /Every free model is out/.test(t.text)))
  assert.ok(manager.trouble.some((t) => /Codex is out; the thinking bots run on Antigravity/.test(t.text)))
  assert.equal(JSON.stringify(manager).includes('/secret'), false)
})

test('a bot health.py rested says until when, not just paused', () => {
  const until = NOW + 3 * 60 * 60 * 1000
  const manager = view([], { files: { ...noFiles(), rested: { senior: { until, text: 'Resting until Fri 18:00' } } } })
  const senior = manager.bots.find((b) => b.id === 'senior')
  assert.equal(senior.why, 'Resting until Fri 18:00')
  assert.equal(senior.resting, true)
  const over = view([], { files: { ...noFiles(), rested: { senior: { until: NOW - 1, text: 'Resting until Mon 09:00' } } } })
  assert.notEqual(over.bots.find((b) => b.id === 'senior').why, 'Resting until Mon 09:00')
})

test('the crew files may be missing, and the logs are read with their times', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-manager-'))
  assert.deepEqual(readCrewFiles(folder), noFiles())
  fs.writeFileSync(path.join(folder, 'merges.log'), '2026-11-10 11:47 LH-355 299ec89ee into harbour main: merged\nnot a line\n')
  fs.writeFileSync(path.join(folder, 'pace.json'), '[1, 2]')
  const files = readCrewFiles(folder)
  assert.deepEqual(files.merges, [{ at: new Date(2026, 10, 10, 11, 47).getTime(), text: 'LH-355 299ec89ee into harbour main: merged' }])
  assert.deepEqual(files.pace, {})
})

test('a busy day still fits in a small answer', () => {
  number = 0
  const issues = []
  const files = noFiles()
  for (let i = 0; i < 120; i += 1) {
    const build = job(`A long title for piece of work number ${i} that goes on and on past what the phone can show in one line`, 'done', 'freelancer', { completedAt: ago(i) })
    issues.push(build, job(`Check ${build.identifier}: ${build.title}`, 'done', 'checker', { completedAt: ago(i) }))
    files.switches.push({ at: NOW - i * 60_000, text: `Freelancer moved from opencode/deepseek-v4.1-flash-free to nvidia/nvidia/nemotron-3-ultra-550b-a55b on try ${i}` })
  }
  const manager = view(issues, { files })
  assert.equal(manager.lines.length, 24)
  assert.equal(manager.feed.length, 40)
  assert.ok(manager.feed[0].at >= manager.feed[39].at)
  assert.ok(JSON.stringify(manager).length < 30 * 1024, `the answer is ${JSON.stringify(manager).length} bytes`)
})

test('clearing a piece of work closes every round of it and its open checks, and nothing else', () => {
  number = 0
  const build = job('Town kit', 'done', 'freelancer')
  const check = job('Check LH-1: Town kit', 'done', 'checker')
  const dropped = job('Fix 1 of Town kit', 'cancelled', 'freelancer')
  const fix = job('Fix 2 of Town kit', 'blocked', 'freelancer')
  const recheck = job('Check LH-4: Fix 2 of Town kit', 'todo', 'checker')
  const other = job('Harbour kit', 'in_progress', 'freelancer')
  const elsewhere = job('Town kit', 'todo', 'freelancer', { projectId: NIGHT })
  const issues = [build, check, dropped, fix, recheck, other, elsewhere]
  assert.deepEqual(workToClear(issues, fix.id).map((i) => i.identifier), ['LH-1', 'LH-4', 'LH-5'])
  assert.deepEqual(workToClear(issues, 'gone'), [])
})

test('the crew keeps fixed places by the chain of command, whoever is working', async () => {
  const { inHierarchy } = await import('../server/lib/manager.mjs')
  const crew = [['Researcher', 'researcher'], ['Freelancer', 'builder'], ['Lead', 'lead'], ['Senior', 'builder'], ['Scout', 'general'], ['Reviewer', 'reviewer'], ['Builder', 'builder'], ['Ruler', 'ruler'], ['Checker', 'checker']]
  const rows = crew.map(([name, role], i) => ({ id: `a${i}`, name, role, status: i % 2 ? 'running' : 'idle' }))
  const order = inHierarchy(rows).map((b) => [b.name, b.tier])
  // By role, never by name: the lead, the judges, the builders, the checkers, the rest.
  assert.deepEqual(order, [['Lead', 'Lead'], ['Ruler', 'Judges'], ['Reviewer', 'Judges'], ['Builder', 'Builders'], ['Freelancer', 'Builders'], ['Senior', 'Builders'],
    ['Checker', 'Checkers'], ['Researcher', 'Research'], ['Scout', 'Crew']])
  const flipped = inHierarchy(rows.map((r) => ({ ...r, status: r.status === 'idle' ? 'running' : 'idle' }))).map((b) => b.name)
  assert.deepEqual(flipped, inHierarchy(rows).map((b) => b.name))
})

test('a bot\'s request for a service is settled from Botyard, and the reason tells the bot where its tools are', async () => {
  const { settleConnectCard } = await import('../server/lib/engine.mjs')
  const sent = []
  const fetcher = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }) }
  await settleConnectCard('card-1', { connected: true, service: 'Cloudflare' }, { fetcher })
  await settleConnectCard('card-2', { connected: false, service: 'Cloudflare' }, { fetcher })
  assert.match(sent[0].url, /\/api\/connection-intents\/card-1\/decline$/)
  assert.match(sent[0].body.reason, /connected Cloudflare in Botyard/)
  assert.match(sent[0].body.reason, /mcp__/)
  assert.match(sent[1].body.reason, /said no/)
})

test('a finished check that never said pass or fail is not read again on every poll', async () => {
  const { readVerdicts } = await import('../server/lib/manager.mjs')
  let reads = 0
  const fetcher = async () => { reads++; return new Response(JSON.stringify([{ body: 'Looked at it; more later.', authorAgentId: 'a' }]), { status: 200 }) }
  const now = Date.parse('2026-11-12T12:00:00Z')
  const check = [{ id: 'check-without-verdict', status: 'done', title: 'Check LH-1: the cistern', completedAt: '2026-11-12T11:00:00Z' }]
  await readVerdicts(check, { fetcher }, now)
  await readVerdicts(check, { fetcher }, now + 3_000)
  await readVerdicts(check, { fetcher }, now + 60_000)
  assert.equal(reads, 1)
  await readVerdicts(check, { fetcher }, now + 6 * 60_000)
  assert.equal(reads, 2, 'looked at again after five minutes')
})

test('the map asks one address: the one the service names, else this computer on the engine\'s port', async () => {
  const { engineBase } = await import('../server/lib/engine.mjs')
  assert.equal(engineBase({}), 'http://127.0.0.1:3210')
  assert.equal(engineBase({ BOTYARD_ENGINE_PORT: '4321' }), 'http://127.0.0.1:4321')
  assert.equal(engineBase({ BOTYARD_API_URL: 'http://127.0.0.1:5000/' }), 'http://127.0.0.1:5000')
  assert.equal(engineBase({ BOTYARD_API_URL: 'http://127.0.0.1:5000/api' }), 'http://127.0.0.1:5000', 'with its /api or without')
})

test('a job marked done whose code is not in main is named in the trouble list, worst first', () => {
  const files = { ...noFiles(), notInMain: { at: new Date(NOW).toISOString(), jobs: [{ job: 'LH-7', branch: 'LH-7-x', commits: 2 }, { job: 'LH-7', branch: 'LH-7-y', commits: 1 }, { job: 'LH-9', branch: 'LH-9-z', commits: 1 }] } }
  const manager = view([job('Seven', 'done', 'senior')], { files })
  const line = manager.trouble.find((t) => /not in main/.test(t.text))
  assert.equal(line.level, 'bad')
  assert.equal(line.text, '2 jobs are marked done but their code is not in main: LH-7, LH-9')
  assert.equal(view([]).trouble.some((t) => /not in main/.test(t.text)), false)
})

test('a request on a track is one work line with its cost so far, and its steps\' jobs are not lines of their own', () => {
  const request = { id: 'r1', jobId: 'req', jobCode: 'LH-40', title: 'Add a lamp', projectId: PROJECTS[0].id, status: 'working', updatedAt: new Date(NOW - 60_000).toISOString(), cost: { usd: 0.42 }, trip: { id: 't1', status: 'running', current: 'check', currentTitle: 'Check', currentKind: 'bot', rounds: { 'check>build': 1 } } }
  const issues = [
    { id: 'req', identifier: 'LH-40', issueNumber: 40, title: 'Add a lamp', status: 'in_progress', projectId: PROJECTS[0].id, createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString() },
    { id: 'step', identifier: 'LH-41', issueNumber: 41, title: 'Add a lamp · Build', parentId: 'req', status: 'done', projectId: PROJECTS[0].id, assigneeAgentId: AGENTS[0].id, createdAt: new Date(NOW - 3_000_000).toISOString(), updatedAt: new Date(NOW - 120_000).toISOString() },
  ]
  const lines = view(issues, { requests: [request] }).lines
  assert.equal(lines.length, 1)
  assert.equal(lines[0].id, 'req')
  assert.equal(lines[0].stage, 'check')
  assert.equal(lines[0].fixes, 1)
  assert.match(lines[0].note, /Check on its track, \$0\.42 so far/)
  const waiting = view(issues, { requests: [{ ...request, trip: { ...request.trip, current: 'owner', currentTitle: 'The owner decides', currentKind: 'gate' } }] }).lines[0]
  assert.equal(waiting.pill, 'waits')
  assert.match(waiting.note, /^Waits for you: The owner decides/)
  const done = view(issues, { requests: [{ ...request, status: 'done' }] }).lines[0]
  assert.equal(done.stage, 'merged')
  assert.equal(done.open, false)
})
