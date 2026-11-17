/**
 * The Work, Projects, Routines and Library readers, against a fake engine. Most of what they do is
 * ask for exactly the right page and leave things out: conversations, environment values, folders
 * outside the home, a file listed twice, and any write to a skill the engine ships read only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  artifactList, editJob, jobIdOf, jobList, jobPage, projectPage, restoreDocument, routinePage,
  saveDocument, saveSkillFile, scheduleWords, setRoutineSchedule, skillFile, skillList,
} from '../server/lib/work.mjs'
import { attachmentFile, uploadAttachment } from '../server/lib/engine.mjs'

const LEAD = '11111111-1111-4111-8111-111111111111'
const FRED = '22222222-2222-4222-8222-222222222222'
const JOB = '55555555-5555-4555-8555-555555555555'
const CHILD = '56555555-5555-4555-8555-555555555555'
const CHAT = '57555555-5555-4555-8555-555555555555'
const BLOCKER = '58555555-5555-4555-8555-555555555555'
const PROJECT = '88888888-8888-4888-8888-888888888888'
const ROUTINE = '99999999-9999-4999-8999-999999999999'
const TRIGGER = '9a999999-9999-4999-8999-999999999999'
const REV = '77777777-7777-4777-8777-777777777777'
const FILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SKILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LOCKED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function engine({ calls = [], triggers = [{ id: TRIGGER, kind: 'schedule', cronExpression: '0 3 * * *', timezone: 'Europe/Berlin', nextRunAt: '2026-11-12T02:00:00Z' }] } = {}) {
  const issue = (id, n, title, status = 'todo', extra = {}) => ({ id, identifier: `LH-${n}`, title, status, projectId: PROJECT, assigneeAgentId: FRED, priority: 'high', lastActivityAt: '2026-11-11T10:00:00Z', ...extra })
  const fetcher = async (url, init = {}) => {
    const u = new URL(url)
    const p = u.pathname.replace('/api', '')
    calls.push({ path: p, query: Object.fromEntries(u.searchParams), method: init.method || 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    if (init.method && init.method !== 'GET') return json({ id: 'new' })
    if (p === '/companies') return json([{ id: 'co', status: 'active' }])
    if (p === '/companies/co/agents') return json([{ id: LEAD, name: 'Lead', role: 'ceo' }, { id: FRED, name: 'Freelancer' }])
    if (p === '/companies/co/projects') return json([{ id: PROJECT, name: 'Lighthouse' }])
    if (p === '/companies/co/chats') return json([{ id: CHAT }])
    if (p === '/companies/co/issues' && u.searchParams.get('parentId')) return json([issue(CHILD, 9, 'Check LH-7: Fix the map', 'done')])
    if (p === '/companies/co/issues') return json([issue(JOB, 7, 'Fix the map', 'in_progress'), issue(CHAT, 8, 'Chat with Freelancer')])
    if (p === '/companies/co/search') return json({ results: [{ type: 'issue', snippet: '...the map is slow...', issue: issue(JOB, 7, 'Fix the map') }, { type: 'comment' }] })
    if (p === '/issues/LH-7' || p === `/issues/${JOB}`) {
      return json({
        ...issue(JOB, 7, 'Fix the map', 'in_progress'), companyId: 'co', description: 'Make it fast',
        ancestors: [{ id: BLOCKER, identifier: 'LH-2', title: 'Plan: the map' }],
        blockedBy: [issue(BLOCKER, 2, 'Plan: the map', 'blocked')], blocks: [],
        workProducts: [
          { id: 'wp1', type: 'artifact', externalId: FILE, title: 'shot.png', metadata: { attachmentId: FILE } },
          { id: 'wp2', type: 'pull_request', title: 'PR 4', url: 'https://example.com/pr/4', status: 'active' },
          { id: 'wp3', type: 'link', title: 'Odd', url: 'javascript:alert(1)' },
        ],
      })
    }
    if (p === `/issues/${JOB}/comments`) return json([])
    if (p === `/issues/${JOB}/attachments`) return json([{ id: FILE, originalFilename: 'shot.png', contentType: 'image/png', byteSize: 1200, objectKey: 'co/secret/path.png' }])
    if (p === `/issues/${JOB}/documents`) return json([{ key: 'plan', title: 'Plan', body: '# Plan', latestRevisionId: REV, latestRevisionNumber: 3, updatedByAgentId: LEAD }])
    if (p === `/issues/${JOB}/runs`) return json([{ runId: 'r1', agentId: FRED, status: 'failed', error: 'Too Many Requests', usageJson: { inputTokens: 10, outputTokens: 5 }, startedAt: '2026-11-11T10:00:00Z', finishedAt: '2026-11-11T10:01:00Z' }])
    if (p === `/issues/${JOB}/cost-summary`) return json({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 900, costCents: 0, runCount: 2, runtimeMs: 60000, includeDescendants: true })
    if (p === `/projects/${PROJECT}`) return json({ id: PROJECT, companyId: 'co', name: 'Lighthouse', env: { KEY: 'secret-value' }, workspaces: [{ name: 'lighthouse', cwd: path.join(os.homedir(), 'Acme/lighthouse'), repoUrl: 'file:///x', isPrimary: true }] })
    if (p === '/companies/co/budgets/overview') return json({ policies: [{ scopeType: 'company', scopeId: 'co', amount: 5 }] })
    if (p === '/companies/co/routines') return json([{ id: ROUTINE, title: 'Nightly', status: 'active', projectId: PROJECT, assigneeAgentId: LEAD, triggers }, { id: 'old', title: 'Gone', status: 'archived', projectId: PROJECT }])
    if (p === '/companies/co/costs/by-project') return json([{ projectId: PROJECT, inputTokens: 10, outputTokens: 5, eventCount: 2 }, { projectId: null, inputTokens: 999 }])
    if (p === `/routines/${ROUTINE}`) return json({ id: ROUTINE, title: 'Nightly', status: 'paused', assigneeAgentId: LEAD, env: { TOKEN: 'secret-value' }, triggers })
    if (p === `/routines/${ROUTINE}/runs`) return json([{ id: 'rr', status: 'failed', source: 'manual', failureReason: 'No bot', triggeredAt: '2026-11-10T03:00:00Z', linkedIssueId: JOB }])
    if (p === `/routines/${ROUTINE}/revisions`) return json([{ id: REV, revisionNumber: 2, createdAt: '2026-11-09T00:00:00Z', snapshot: { routine: { env: { TOKEN: 'secret-value' } } } }])
    if (p === '/companies/co/artifacts') return json({ artifacts: [{ id: 'work_product:1', source: 'work_product', mediaKind: 'image', title: 'shot.png', contentPath: `/api/attachments/${FILE}/content`, issue: { id: JOB, identifier: 'LH-7', title: 'Fix the map' }, project: { id: PROJECT, name: 'Lighthouse' }, createdByAgent: { name: 'Freelancer' } }], nextCursor: 'abc_D' })
    if (p === '/companies/co/skills') return json([{ id: LOCKED, name: 'engine', editable: false, editableReason: 'Bundled skills are read-only.', fileInventory: [{ path: 'SKILL.md' }], sourceLocator: '/home/x' }, { id: SKILL, name: 'crew', editable: true, fileInventory: [{ path: 'SKILL.md' }] }])
    if (p === `/companies/co/skills/${LOCKED}`) return json({ id: LOCKED, editable: false, editableReason: 'Bundled skills are read-only.' })
    if (p === `/companies/co/skills/${SKILL}`) return json({ id: SKILL, editable: true })
    if (p === `/companies/co/skills/${SKILL}/files`) return json({ path: 'SKILL.md', content: '# Crew', markdown: true, editable: true })
    return json({ error: 'no' }, 404)
  }
  return { fetcher, retired: [], calls }
}

test('the work list asks the engine for one pile, project and bot a page at a time, and leaves chats out', async () => {
  const fake = engine()
  const list = await jobList({ pile: 'active', project: PROJECT, bot: FRED, page: 2, ...fake })
  const asked = fake.calls.find((c) => c.path === '/companies/co/issues')
  assert.deepEqual(asked.query, { limit: '41', offset: '80', status: 'in_progress,in_review,blocked,todo', projectId: PROJECT, assigneeAgentId: FRED, view: 'compact' })
  assert.deepEqual(list.jobs.map((j) => [j.ref, j.title, j.state, j.bot, j.project]), [['LH-7', 'Fix the map', 'Working', 'Freelancer', 'Lighthouse']])
  assert.equal(list.more, false)
  assert.deepEqual(list.bots.map((b) => b.name), ['Freelancer', 'Lead'])
  await assert.rejects(jobList({ pile: 'everything', ...fake }), /active, backlog or done/)
  await assert.rejects(jobList({ bot: '../x', ...fake }), /not a bot id/)
})

test('words search through the engine search, and show where they were found', async () => {
  const fake = engine()
  const list = await jobList({ pile: 'done', q: '  slow map ', ...fake })
  const asked = fake.calls.find((c) => c.path === '/companies/co/search')
  assert.equal(asked.query.q, 'slow map')
  assert.equal(asked.query.scope, 'issues')
  assert.equal(asked.query.status, 'done,cancelled')
  assert.equal(list.jobs.length, 1)
  assert.equal(list.jobs[0].snippet, '...the map is slow...')
})

test("a job's page has its parent, blockers, sub-jobs, documents, files once, runs and cost", async () => {
  const fake = engine()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'previews-'))
  const key = 'f'.repeat(32)
  fs.mkdirSync(path.join(dir, key))
  fs.writeFileSync(path.join(dir, key, 'manifest.json'), JSON.stringify({ job: JOB, ok: true, name: 'Lighthouse', builtAt: '2026-11-11' }))
  const page = await jobPage('LH-7', { previews: dir, ...fake })
  assert.equal(page.id, JOB)
  assert.equal(page.ref, 'LH-7')
  assert.equal(page.parent.ref, 'LH-2')
  assert.deepEqual(page.blockedBy.map((b) => [b.ref, b.state]), [['LH-2', 'Blocked']])
  assert.deepEqual(page.children.map((c) => c.title), ['Checked: Fix the map'])
  assert.deepEqual(page.documents.map((d) => [d.key, d.revision, d.by]), [['plan', 3, 'Lead']])
  assert.deepEqual(page.files.map((f) => [f.name, f.kind]), [['shot.png', 'image']])
  assert.equal(JSON.stringify(page).includes('secret/path'), false)
  assert.deepEqual(page.products.map((w) => [w.title, w.url]), [['PR 4', 'https://example.com/pr/4'], ['Odd', '']])
  assert.equal(page.runs[0].why, "A free model's limit was reached")
  assert.equal(page.runs[0].tokens, 15)
  assert.deepEqual(page.cost, { tokens: 150, cached: 900, cents: 0, runs: 2, seconds: 60, withSubJobs: true })
  assert.equal(page.previews[0].url, `http://127.0.0.1:5290/open/${key}`)
  assert.equal(page.branch, null)
  await assert.rejects(jobIdOf('LH-7/../x', fake), /not a job/)
})

test('editing a job changes only what was sent, and only to a bot or project of this studio', async () => {
  const fake = engine()
  await editJob(JOB, { title: ' New title ', priority: 'low', botId: LEAD, projectId: '' }, fake)
  const patch = fake.calls.find((c) => c.method === 'PATCH')
  assert.equal(patch.path, `/issues/${JOB}`)
  assert.deepEqual(patch.body, { title: 'New title', priority: 'low', projectId: null, assigneeAgentId: LEAD })
  await assert.rejects(editJob(JOB, { botId: '12345678-1234-4234-8234-123456789012' }, engine()), /not in this studio/)
  await assert.rejects(editJob(JOB, { priority: 'urgent' }, engine()), /Priority/)
  await assert.rejects(editJob(JOB, {}, engine()), /Nothing to change/)
  await assert.rejects(editJob('x', { title: 'a' }, engine()), /not a job id/)
})

test('a document is saved as a new version on top of the one read, and restored the same way', async () => {
  const fake = engine()
  await saveDocument(JOB, 'plan', { body: '# New', baseRevisionId: REV }, fake)
  await restoreDocument(JOB, 'plan', REV, fake)
  const [put, restore] = fake.calls.filter((c) => c.method !== 'GET')
  assert.equal(put.method, 'PUT')
  assert.equal(put.path, `/issues/${JOB}/documents/plan`)
  assert.deepEqual(put.body, { format: 'markdown', body: '# New', changeSummary: 'Edited on the map', baseRevisionId: REV })
  assert.equal(restore.path, `/issues/${JOB}/documents/plan/revisions/${REV}/restore`)
  await assert.rejects(saveDocument(JOB, '../x', { body: 'a' }, fake), /not a document/)
  await assert.rejects(saveDocument(JOB, 'plan', { body: '  ' }, fake), /empty/)
})

test("a project's page has its folders, its routines and spend, and a budget only when one is set", async () => {
  const fake = engine()
  const page = await projectPage(PROJECT, fake)
  assert.deepEqual(page.folders, [{ name: 'lighthouse', folder: '~/Acme/lighthouse', repo: '', primary: true }])
  assert.equal(page.budget, null)
  assert.deepEqual(page.routines.map((r) => [r.title, r.bot, r.when]), [['Nightly', 'Lead', 'Every day at 03:00']])
  assert.deepEqual(page.spend, { tokens: 15, runs: 2, cents: 0 })
  assert.equal(JSON.stringify(page).includes('secret-value'), false)
})

test("a routine's page says when it runs in words, with its runs and versions and no settings values", async () => {
  const page = await routinePage(ROUTINE, engine())
  assert.equal(page.when, 'Every day at 03:00')
  assert.deepEqual(page.plan, { kind: 'daily', at: '03:00' })
  assert.equal(page.schedule, 'nightly')
  assert.equal(page.paused, true)
  assert.deepEqual(page.runs.map((r) => [r.state, r.why, r.by, r.job?.ref]), [['Failed', 'No bot', 'By hand', 'LH-7']])
  assert.deepEqual(page.revisions.map((r) => r.number), [2])
  assert.equal(JSON.stringify(page).includes('secret-value'), false)
  assert.equal(scheduleWords(''), 'Only when started by hand')
  assert.equal(scheduleWords('*/5 * * * *'), 'Every 5 minutes')
  assert.equal(scheduleWords('5,35 * * * *'), 'On its own timetable (5,35 * * * *)')
})

test("a routine's schedule moves its own timer, or gets one when it has none", async () => {
  const moved = engine()
  await setRoutineSchedule(ROUTINE, 'weekdays', 'Europe/Berlin', moved)
  assert.deepEqual(moved.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]), [['PATCH', `/routine-triggers/${TRIGGER}`, { cronExpression: '0 7 * * 1-5', timezone: 'Europe/Berlin' }]])
  const fresh = engine({ triggers: [] })
  await setRoutineSchedule(ROUTINE, 'weekly', null, fresh)
  assert.deepEqual(fresh.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]), [['POST', `/routines/${ROUTINE}/triggers`, { kind: 'schedule', cronExpression: '0 4 * * 1', timezone: 'UTC' }]])
  await assert.rejects(setRoutineSchedule(ROUTINE, '* * * * *', null, engine()), /Choose when it runs/)
  const planned = engine()
  assert.equal((await setRoutineSchedule(ROUTINE, { kind: 'minutes', n: 30 }, null, planned)).when, 'Every 30 minutes')
  assert.deepEqual(planned.calls.filter((c) => c.method !== 'GET').map((c) => c.body), [{ cronExpression: '*/30 * * * *' }])
  await assert.rejects(setRoutineSchedule(ROUTINE, 'nightly', 'Europe/../x', engine()), /time zone/)
})

test('the library lists what the crew made with its job, and skills say whether they can be changed', async () => {
  const fake = engine()
  const page = await artifactList({ cursor: 'abc', ...fake })
  assert.equal(page.items[0].file, FILE)
  assert.equal(page.items[0].job.ref, 'LH-7')
  assert.equal(page.next, 'abc_D')
  await assert.rejects(artifactList({ cursor: 'a b/c', ...fake }), /not a page/)
  const skills = await skillList(fake)
  assert.deepEqual(skills.map((s) => [s.name, s.editable, s.locked]), [['crew', true, ''], ['engine', false, 'Comes with Botyard: read only']])
  assert.equal(JSON.stringify(skills).includes('/home/x'), false)
  assert.equal((await skillFile(SKILL, 'SKILL.md', fake)).content, '# Crew')
  for (const bad of ['../x', '/etc/passwd', 'a//b', '.git/config']) await assert.rejects(skillFile(SKILL, bad, fake), /not a file of the skill/)
})

test('a skill file is written only for a skill that can be changed', async () => {
  const fake = engine()
  await saveSkillFile(SKILL, { path: 'SKILL.md', content: '# Crew v2' }, fake)
  assert.deepEqual(fake.calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body]), [[`/companies/co/skills/${SKILL}/files`, { path: 'SKILL.md', content: '# Crew v2' }]])
  const locked = engine()
  await assert.rejects(saveSkillFile(LOCKED, { path: 'SKILL.md', content: 'x' }, locked), /read only/)
  assert.equal(locked.calls.some((c) => c.method !== 'GET'), false)
})

test('the library lists every skill on the PC with who has it, reads only inside its folder and never writes it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-skills-'))
  const dir = path.join(home, 'qa')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# QA')
  fs.writeFileSync(path.join(home, 'secret.txt'), 'no')
  fs.symlinkSync(path.join(home, 'secret.txt'), path.join(dir, 'out.md'))
  const QA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const ROBLOX = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const index = path.join(home, 'skills-index.json')
  fs.writeFileSync(index, JSON.stringify({ skills: [
    { id: QA, name: 'qa', dir, description: 'Test a site', files: ['SKILL.md', 'out.md'], bots: ['Builder', 'Freelancer'], leftOut: '' },
    { id: ROBLOX, name: 'roblox-ui', dir: path.join(home, 'none'), description: 'Roblox', files: ['SKILL.md'], bots: [], leftOut: 'No project of ours is on this engine.' },
    { id: 'not-an-id', name: 'bad', dir, files: [] },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'engine', dir, description: 'The PC copy', files: ['SKILL.md'], bots: ['Lead'] },
  ] }))
  const fake = { ...engine(), skillsIndex: index }
  const skills = await skillList(fake)
  assert.deepEqual(skills.map((s) => [s.name, s.locked]), [
    ['crew', ''], ['engine', 'Given to Lead'], ['qa', 'Given to Builder, Freelancer'], ['roblox-ui', 'No bot']])
  assert.equal(skills.find((s) => s.name === 'roblox-ui').description, 'Roblox No bot has it: No project of ours is on this engine.')
  assert.equal(skills.find((s) => s.name === 'qa').bots, 2)
  assert.equal(JSON.stringify(skills).includes(home), false)
  assert.equal((await skillFile(QA, 'SKILL.md', fake)).content, '# QA')
  assert.equal((await skillFile(QA, 'out.md', fake)).content, '')
  await assert.rejects(skillFile(QA, '../secret.txt', fake), /not a file of the skill/)
  await assert.rejects(saveSkillFile(QA, { path: 'SKILL.md', content: 'x' }, fake), /lives on the PC/)
  assert.equal(fake.calls.some((c) => c.method !== 'GET' || c.path.includes(QA)), false)
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '# QA')
  fs.rmSync(home, { recursive: true, force: true })
})

test('a file is attached as the engine upload form, and only of the kinds the map allows', async () => {
  const fake = engine()
  await uploadAttachment(JOB, { name: '../notes.md', type: 'text/markdown', bytes: Buffer.from('# hi') }, fake)
  const sent = fake.calls.find((c) => c.method === 'POST')
  assert.equal(sent.path, `/companies/co/issues/${JOB}/attachments`)
  const file = sent.body.get('file')
  assert.equal(file.name, '..notes.md')
  assert.equal(file.type, 'text/markdown')
  await assert.rejects(uploadAttachment(JOB, { name: 'a.html', type: 'text/html', bytes: Buffer.from('x') }, engine()), /Attach an image/)
  await assert.rejects(uploadAttachment(JOB, { name: 'a.png', type: 'image/png', bytes: Buffer.alloc(0) }, engine()), /empty/)
})

test('a file is shown as an image or text, and anything else only as a download', async () => {
  const answer = (type) => ({ fetcher: async () => new Response('x', { headers: { 'content-type': type } }) })
  assert.equal((await attachmentFile(FILE, answer('image/png'))).type, 'image/png')
  assert.equal((await attachmentFile(FILE, answer('text/markdown; charset=utf-8'))).type, 'text/plain; charset=utf-8')
  const html = await attachmentFile(FILE, answer('text/html'))
  assert.deepEqual([html.type, html.download], ['application/octet-stream', true])
  await assert.rejects(attachmentFile('../x', answer('image/png')), /not a file id/)
})
