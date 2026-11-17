// The Improvements page: one plain file the crew writes (own/improvements.py), one read-only view, the same list on the PC and the phone.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { improvementsView } from '../server/lib/crew.mjs'
import http from 'node:http'
import { decidedLine, historyLine, improvementsScreen } from '../src/ui/studio-crew.js'
import { decideImprovement } from '../server/lib/improvement-actions.mjs'
import * as phoneText from '../../src/improvementText.ts'

const folderWith = (content) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'improvements-'))
  if (content !== undefined) fs.writeFileSync(path.join(folder, 'improvements.json'), typeof content === 'string' ? content : JSON.stringify(content))
  return folder
}
const ITEMS = [
  { id: 'IMP-1', title: 'Old briefs stay', path: 'briefs/tony', evidence: '212 files', fix: 'Move them', who: 'Freya', status: 'done', job: 'NGE-955', added: 100 },
  { id: 'IMP-2', title: 'Reports <b>name</b> no commit', path: 'own/review-guard.py', evidence: 'NGE-931', fix: 'Refuse it', who: 'Tony', status: 'new', job: '', added: 200 },
  { id: 'IMP-3', title: 'Second new one', path: 'x', evidence: '', fix: '', who: 'Freya', status: 'new', job: '', added: 300 },
  { id: 'IMP-4', title: 'Not worth it', path: 'y', status: 'rejected', added: 50 },
  { id: 'IMP-5', title: 'Odd state', path: 'z', status: 'sideways', added: 10 },
  { title: '' },
  'junk',
]

test('the view lists findings by state then newest, counts each state, and unknown states read as new', () => {
  const view = improvementsView({ folder: folderWith(ITEMS) })
  assert.deepEqual(view.items.map((i) => i.id), ['IMP-3', 'IMP-2', 'IMP-5', 'IMP-1', 'IMP-4'])
  assert.deepEqual(view.counts, { new: 3, ask: 0, accepted: 0, done: 1, rejected: 1, stale: 0 })
  assert.deepEqual(Object.keys(view.items[0]).sort(), ['added', 'decidedAt', 'decidedBy', 'evidence', 'fix', 'history', 'id', 'job', 'path', 'reason', 'status', 'title', 'who'])
})

test('a missing, empty or broken file is an empty list, never an error', () => {
  for (const folder of [folderWith(), folderWith('{not json'), folderWith({ not: 'a list' })]) {
    assert.deepEqual(improvementsView({ folder }), { items: [], counts: { new: 0, ask: 0, accepted: 0, done: 0, rejected: 0, stale: 0 } })
  }
})

const T16 = Date.UTC(2026, 10, 16, 12) / 1000
const T17 = Date.UTC(2026, 10, 17, 12) / 1000
const FINDINGS = [
  { id: 'IMP-1', title: 'Old briefs stay', path: 'briefs/tony', evidence: '212 files', fix: 'Move them', who: 'Freya', status: 'rejected', job: '', added: 1, decidedBy: 'tony', decidedAt: T16, reason: 'We already do this in a long reason that must never be cut short, however many words it takes to say it in full.' },
  { id: 'IMP-2', title: 'Reports name no commit', path: 'own/review-guard.py', evidence: 'NGE-931', fix: 'Refuse it', who: 'Tony', status: 'new', job: '', added: 2, project: 'nGen Studio' },
  { id: 'IMP-3', title: 'Asked one', path: 'a', evidence: 'e', fix: 'f', who: 'Tony', status: 'ask', job: 'OWN-1190', added: 3, decidedBy: 'tony', decidedAt: T16, reason: 'Needs you.' },
]

test('the PC page shows status chip, who decided and when, the full reason, the job link, evidence, and the four buttons', () => {
  const data = improvementsView({ folder: folderWith(FINDINGS) })
  const all = improvementsScreen(data, '')
  assert.ok(all.includes('chip imp-rejected">Rejected') && all.includes('chip imp-new">New') && all.includes('chip imp-ask">Ask me'))
  assert.ok(all.includes('Decided by Tony, 16 Nov.') && all.includes('Why: We already do this in a long reason that must never be cut short, however many words it takes to say it in full.'))
  assert.ok(all.includes('data-act="open-job" data-id="OWN-1190"') && all.includes('Evidence: 212 files') && all.includes('No job yet'))
  for (const act of ['improve-accept', 'improve-reject-open', 'improve-ask', 'improve-send', 'improve-reject-go']) assert.ok(all.includes(`data-act="${act}"`), act)
  assert.ok(all.includes('aria-label="Accept finding IMP-2: Reports name no commit"') && all.includes('<label for="why-IMP-2">'))
  assert.ok(!all.includes('…'), 'the reason is never truncated')
})

test('the page opens on what waits for a decision (New and Ask me), and every filter works', () => {
  const data = improvementsView({ folder: folderWith(FINDINGS) })
  const open = improvementsScreen(data)
  assert.ok(open.includes('Reports name no commit') && open.includes('Asked one') && !open.includes('Old briefs stay'))
  for (const name of ['To decide 2', 'All 3', 'New 1', 'Ask me 1', 'Accepted 0', 'Done 0', 'Rejected 1', 'Stale 0']) assert.ok(open.includes(name), name)
  assert.ok(improvementsScreen(data, 'rejected').includes('Old briefs stay'))
  assert.ok(improvementsScreen(data, 'done').includes('Nothing in this state.'))
  assert.ok(improvementsScreen({ items: [], counts: {} }, '').includes('No improvements listed yet.'))
  assert.ok(improvementsScreen({ items: [{ id: 'IMP-9', title: '<i>x</i>', status: 'new' }], counts: { new: 1 } }, 'open').includes('&lt;i&gt;x&lt;/i&gt;'))
})

test('the change history reads in one line, on the PC page and in the phone screen words', () => {
  const item = { status: 'accepted', decidedBy: 'owner', decidedAt: T17, history: [{ by: 'tony', status: 'rejected', at: T16 }] }
  assert.equal(historyLine(item), 'Tony rejected 16 Nov; you accepted 17 Nov')
  assert.equal(phoneText.historyLine(item), 'Tony rejected 16 Nov; you accepted 17 Nov')
  assert.equal(decidedLine(item), 'Decided by you, 17 Nov')
  assert.equal(phoneText.decidedLine(item), 'Decided by you, 17 Nov')
  assert.equal(historyLine({ status: 'new' }), '')
  assert.equal(phoneText.historyLine({ status: 'rejected', decidedBy: 'tony', decidedAt: T16 }), '')
  assert.equal(phoneText.STATUS_NAMES.ask, 'Ask me')
})

// ── the buttons ────────────────────────────────────────────────────────────────────────

/** A fake engine that records what it was asked: two projects, Tony and a builder. */
function fakeEngine() {
  const calls = []
  const fetcher = async (url, init) => {
    const where = String(url).replace(/^.*\/api/, '').replace(/^\/companies\/[^/]+/, '/companies/c1')
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ where, method: init?.method, body })
    const answer = (value, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(value) })
    if (where === '/companies') return answer([{ id: 'c1', status: 'active' }])
    if (where === '/companies/c1/projects') return answer([{ id: 'p-own', name: 'nGen Own' }, { id: 'p-studio', name: 'nGen Studio' }])
    if (where === '/companies/c1/agents') return answer([{ id: 'a-tony', name: 'Tony Yayo', role: 'ceo' }, { id: 'a-bob', name: 'Bob The Builder' }])
    if (where === '/companies/c1/issues' && init.method === 'POST') return answer({ id: 'i1', identifier: 'NGE-77', displayIdentifier: 'OWN-77' })
    return answer({ error: `unexpected ${init?.method} ${where}` }, false)
  }
  return { calls, engine: { fetcher } }
}
const read = (folder, name) => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
const yardOf = () => { const folder = folderWith(JSON.parse(JSON.stringify(FINDINGS))); return folder }

test('Accept makes a backlog job in the finding\'s project with the fix as the outline, and records the owner\'s decision', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'accept' }, { folder, engine, now: T17 })
  assert.equal(done.jobRef, 'OWN-77')
  const issue = calls.find((c) => c.where === '/companies/c1/issues').body
  assert.equal(issue.projectId, 'p-studio')
  assert.ok(issue.description.includes('Smallest fix: Refuse it') && issue.description.includes('Brief outline: Refuse it'))
  const item = read(folder, 'improvements.json').find((i) => i.id === 'IMP-2')
  assert.deepEqual([item.status, item.decidedBy, item.decidedAt, item.job], ['accepted', 'owner', T17, 'OWN-77'])
})

test('a finding with no project goes to nGen Own', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  await decideImprovement('IMP-3', { action: 'accept' }, { folder, engine, now: T17 })
  assert.equal(calls.find((c) => c.where === '/companies/c1/issues').body.projectId, 'p-own')
})

test('Reject needs a reason, remembers the title, and creates no job', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'reject', reason: '  ' }, { folder, engine }), /why you reject/)
  assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
  const done = await decideImprovement('IMP-2', { action: 'reject', reason: 'Not worth\nthe work' }, { folder, engine, now: T17 })
  assert.equal(done.item.reason, 'Not worth the work')
  assert.deepEqual(read(folder, 'improvements-rejected.json').titles, ['reports name no commit'])
  assert.equal(calls.length, 0)
})

test('Ask me changes the status and creates nothing', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'ask' }, { folder, engine, now: T17 })
  assert.deepEqual([done.item.status, done.item.decidedBy], ['ask', 'owner'])
  assert.equal(calls.length, 0)
})

test('Send to Tony makes a job assigned to Tony in the finding\'s project, with evidence, fix and the instruction to plan and start', async () => {
  const folder = yardOf(); const { calls, engine } = fakeEngine()
  const done = await decideImprovement('IMP-2', { action: 'send' }, { folder, engine, now: T17 })
  const issue = calls.find((c) => c.where === '/companies/c1/issues').body
  assert.equal(issue.assigneeAgentId, 'a-tony')
  assert.equal(issue.projectId, 'p-studio')
  assert.ok(issue.description.includes('Evidence: NGE-931') && issue.description.includes('Plan this and start it.'))
  assert.equal(done.item.job, 'OWN-77')
})

test('the owner overrides Tony\'s decision, and the history keeps both, in one line', async () => {
  const folder = yardOf(); const { engine } = fakeEngine()
  await decideImprovement('IMP-1', { action: 'accept' }, { folder, engine, now: T17 })
  const view = improvementsView({ folder }).items.find((i) => i.id === 'IMP-1')
  assert.deepEqual([view.status, view.decidedBy], ['accepted', 'owner'])
  assert.equal(historyLine(view), 'Tony rejected 16 Nov; you accepted 17 Nov')
  // A second click changes it again, and nothing is lost.
  await decideImprovement('IMP-1', { action: 'ask' }, { folder, engine, now: T17 + 60 })
  const again = improvementsView({ folder }).items.find((i) => i.id === 'IMP-1')
  assert.equal(again.status, 'ask')
  assert.equal(again.history.length, 2)
  assert.equal(read(folder, 'improvements.json').length, 3)
})

test('a bad action, an unknown finding or a missing engine changes nothing', async () => {
  const folder = yardOf()
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'delete' }, { folder }), /accept, reject, ask or send/)
  await assert.rejects(() => decideImprovement('IMP-99', { action: 'ask' }, { folder }), /No such finding/)
  await assert.rejects(() => decideImprovement('IMP-2', { action: 'accept' }, { folder, engine: { fetcher: async () => { throw new Error('down') } } }), /not running/)
  assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
})

test('through the map\'s API: the page decides, any other caller is refused', async () => {
  const folder = yardOf()
  const saved = process.env.BOTYARD_CREW_FOLDER
  process.env.BOTYARD_CREW_FOLDER = folder
  try {
    const { apiMiddleware } = await import(`../server/api.mjs?improve-${Date.now()}`)
    const server = http.createServer((req, res) => apiMiddleware(req, res, null))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/api/studio/improvements/IMP-2`
    const post = (headers, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    try {
      const mine = { Origin: `http://localhost:${port}` }
      assert.equal((await post({ Origin: 'https://elsewhere.example' }, { action: 'ask' })).status, 403)
      assert.equal((await post({}, { action: 'ask' })).status, 403)
      assert.equal(read(folder, 'improvements.json').find((i) => i.id === 'IMP-2').status, 'new')
      const noReason = await post(mine, { action: 'reject' })
      assert.equal(noReason.status, 400)
      const rejected = await post(mine, { action: 'reject', reason: 'No' })
      assert.equal(rejected.status, 200)
      const list = await (await fetch(`http://127.0.0.1:${port}/api/studio/improvements`)).json()
      const item = list.items.find((i) => i.id === 'IMP-2')
      assert.deepEqual([item.status, item.decidedBy, item.reason], ['rejected', 'owner', 'No'])
      assert.equal((await post(mine, { action: 'nope' })).status, 400)
    } finally { server.close() }
  } finally { if (saved === undefined) delete process.env.BOTYARD_CREW_FOLDER; else process.env.BOTYARD_CREW_FOLDER = saved }
})
